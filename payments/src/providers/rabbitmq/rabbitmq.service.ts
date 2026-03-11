/* eslint-disable @typescript-eslint/no-unsafe-argument */
// src/payment/rabbitmq/rabbitmq.service.ts
import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';

@Injectable()
export class RabbitMQService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: any = null;
  private channel: any = null;

  // хук жизненного цикла
  async onModuleInit() {
    await this.connect();
  }

  /**
   * Пул активных подписок для автоматического восстановления (Self-Healing)
   * при переподключении к брокеру.
   */
  // Хранилище для подписок: ключ — имя очереди, значение — функция-обработчик
  private subscriptions: Map<string, (message: any) => Promise<void>> =
    new Map();

  /**
   * Инициализация соединения с RabbitMQ.
   * Реализует паттерн "Retry Connection" при первичной неудаче.
   */
  async connect() {
    const rabbitMqUrl =
      process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';

    if (!rabbitMqUrl) {
      throw new Error('RABBITMQ_URL environment variable is required');
    }

    this.logger.log(`Connecting to RabbitMQ: ${rabbitMqUrl}`);

    try {
      const amqp = await import('amqplib');
      this.connection = await amqp.connect(rabbitMqUrl);

      // 1. Слушаем ошибки соединения
      this.connection.on('error', (err) => {
        this.logger.error('RabbitMQ connection error', err);
      });

      // 2. Логика реконнекта при закрытии
      this.connection.on('close', () => {
        this.logger.warn(
          'RabbitMQ connection closed. Reconnecting in 5 seconds...',
        );
        this.connection = null;
        this.channel = null;
        setTimeout(() => this.connect(), 5000); // Пробуем переподключиться через 5 сек
      });

      this.channel = await this.connection.createChannel();

      /**
       * QOS (Quality of Service) / Prefetch Count:
       * Ограничиваем количество неподтвержденных сообщений (Unacked) до 1.
       * Предотвращает "захлебывание" воркера (Consumer Saturation)
       * при массовом наплыве транзакций.
       */
      // 3. Установка Prefetch (очень важно!)
      // Не дает сервису захлебнуться, берем 1 сообщение за раз
      await this.channel.prefetch(1);

      // ---  Настройка плагина задержки ---

      /**
       * Delayed Message Exchange (x-delayed-message):
       * Инфраструктура для Dunning-процессов (дожима оплат).
       * Позволяет откладывать выполнение логики (например, повтор через 15 мин)
       * на стороне брокера, не нагружая память Node.js таймерами.
       */
      // 1. Объявляем Exchange с типом x-delayed-message
      await this.channel.assertExchange(
        'dunning.delayed_exchange',
        'x-delayed-message',
        {
          durable: true,
          arguments: {
            'x-delayed-type': 'direct', // Внутренний тип распределения
          },
        },
      );

      // 2. Объявляем очередь для шагов даннинга
      const dunningProcessQueue = 'dunning.process_step';
      /**
       * Quorum Queues:
       * Используем Raft-алгоритм для обеспечения высокой доступности (High Availability).
       * Гарантирует сохранность финансовых данных за счет репликации между узлами кластера.
       */
      await this.channel.assertQueue(dunningProcessQueue, {
        durable: true,
        arguments: { 'x-queue-type': 'quorum' },
      });

      // 3. Привязываем очередь к обменнику задержки
      // Все сообщения с этим routingKey будут попадать сюда после паузы
      await this.channel.bindQueue(
        dunningProcessQueue,
        'dunning.delayed_exchange',
        'process_step',
      );

      // --- Конец настроек плагина ---

      // Объявляем все необходимые очереди
      const queues = [
        'payment.created',
        'payment.succeeded',
        'payment.failed',
        'payment.refunded',
        'payment.retry_succeeded',
        'payment.recurring_succeeded',
        'subscription.created',
        'subscription.canceled',
        'subscription.renewal_due',
        'invoice.created',
        'dunning.started',
        'dunning.stage_completed',
        'notification.dunning',
        'yookassa.webhook',
      ];

      for (const queue of queues) {
        await this.channel.assertQueue(queue, {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum', // Для надежности
          },
        });
      }

      this.logger.log('✅ RabbitMQ connected and channel initialized');

      // АВТО-ПЕРЕПОДПИСКА: если были активные подписки, восстанавливаем их
      if (this.subscriptions.size > 0) {
        this.logger.log(
          `Restoring ${this.subscriptions.size} subscriptions...`,
        );
        for (const [queue, callback] of this.subscriptions.entries()) {
          await this.setupSubscriber(queue, callback);
        }
      }
    } catch (error) {
      this.logger.error('❌ Failed to connect to RabbitMQ', error);
      // Если не удалось подключиться при старте — пробуем еще раз через 5 сек
      this.logger.log('Retrying connection in 5 seconds...');
      setTimeout(() => this.connect(), 5000);
    }

    // 1. Объявляем Exchange для битых сообщений (Dead Letter Exchange)
    /**
     * Объявляем обменник (Exchange) для "мертвых" сообщений.
     * Это "диспетчер", который знает, куда слать брак.
     * Зачем: Это точка входа для всех ошибок. durable: true — чтобы
     * этот «диспетчер» не исчез, если RabbitMQ перезагрузится.
     */
    await this.channel.assertExchange('payments.dlx', 'direct', {
      durable: true,
    });

    // 2. Объявляем очередь "отстойник"
    /**
     * Создаем саму очередь-отстойник "failed_final".
     * Тут сообщения будут лежать вечно, пока их не посмотрит человек.
     * Зачем: Это физическое место хранения «битых» данных. Мы используем
     * Quorum (Raft), потому что даже ошибки в платежах — это важные данные,
     * их нельзя терять.
     */
    await this.channel.assertQueue('payments.failed_final', { durable: true });

    // 3. Привязываем
    /**
     * Соединяем "диспетчера" и "полку".
     * Мы говорим: "Если в обменник dlx пришло что-то с пометкой
     * 'failed' — клади в эту очередь".
     *
     */
    await this.channel.bindQueue(
      'payments.failed_final',
      'payments.dlx',
      'failed',
    );
    // 4. При создании ОСНОВНОЙ очереди добавляем аргументы:
    /**
     * Настраиваем «Авто-сброс» в основной очереди
     * Это самая магия. Мы настраиваем основную очередь так,
     * чтобы она сама знала, куда выкидывать мусор.
     * Как это работает: Если в коде (в setupSubscriber)
     * ты вызовешь nack(msg, false, false)
     * (отклонить без возврата в очередь),
     * Кролик сам посмотрит на эти аргументы и перекинет сообщение на
     * «штрафную стоянку».
     */
    await this.channel.assertQueue('payment.created', {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum', // Надежность Raft
        // ГЛАВНОЕ: Ссылка на наш DLX обменник
        'x-dead-letter-exchange': 'payments.dlx', // КУДА слать при nack(false)
        // Метка, с которой сообщение улетит в DLX
        'x-dead-letter-routing-key': 'failed', // С каким ключом
      },
    });
  }

  // Публичный метод для подписки (теперь он просто регистрирует колбэк)
  async subscribe(queue: string, callback: (message: any) => Promise<void>) {
    // запоминаем для реконнекта
    this.subscriptions.set(queue, callback);
    if (this.channel) {
      await this.setupSubscriber(queue, callback);
    }
  }

  /**
   * Идемпотентный потребитель (Idempotent Consumer) с ручным подтверждением.
   *
   * @param queue - Имя очереди
   * @param callback - Бизнес-логика обработки (например, списание средств)
   *
   * ВАЖНО: Используется Manual Acknowledgment (ACK).
   * Сообщение удаляется из очереди ТОЛЬКО после успешного выполнения callback.
   */
  // Внутренний метод настройки потребления (consume)
  private async setupSubscriber(
    queue: string,
    callback: (message: any) => Promise<void>,
  ) {
    await this.channel.consume(queue, async (msg) => {
      if (!msg) return;

      try {
        const content = JSON.parse(msg.content.toString());

        // Выполняем бизнес-логику (например, оплату)
        await callback(content);

        /**
         * ACK (Acknowledgment):
         * Подтверждаем брокеру, что сообщение успешно обработано и зафиксировано в БД.
         */
        // Если всё ок — удаляем из очереди
        this.channel.ack(msg);
      } catch (error) {
        this.logger.error(`Ошибка в ${queue}: ${error.message}`);

        // ЛОГИКА РЕТРИЯ:
        // Проверяем, сколько раз это сообщение уже пытались обработать
        const deliveryCount = msg.properties.headers['x-delivery-count'] || 0;

        if (deliveryCount < 3) {
          // Вариант А: Простой ретри (закинуть обратно в ту же очередь)
          // Внимание: это может зациклить очередь, если не использовать задержку!
          // Ретри
          this.channel.nack(msg, false, true); // true в конце = requeue
        } else {
          // Вариант Б: Отправить в Dead Letter Queue или просто залогировать критический сбой
          this.logger.fatal(
            `Сообщение окончательно не обработано: ${msg.content.toString()}`,
          );
          /**
           * NACK (Negative Acknowledgment) & Retry Strategy:
           * Если произошла ошибка, проверяем x-delivery-count (из заголовков).
           * Если лимит ретраев не исчерпан — возвращаем в очередь (Requeue: true).
           * Если исчерпан — отправляем в Dead Letter Queue (DLQ) для ручного разбора.
           */
          // В DLQ или удаление
          this.channel.nack(msg, false, false); // Удаляем, чтобы не спамило
        }
      }
    });
  }
  /**
   * Публикация сообщения с гарантией сохранности (Persistent).
   *
   * @param queue - Целевая очередь
   * @param message - Тело транзакции (JSON)
   * @returns boolean - Результат записи в буфер сокета
   */
  // отправить в очередь
  async sendToQueue(queue: string, message: any): Promise<boolean> {
    if (!this.channel) {
      await this.connect();
    }

    if (!this.channel) {
      throw new Error('RabbitMQ channel not available');
    }

    return this.channel.sendToQueue(
      queue,
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        contentType: 'application/json',
        timestamp: Date.now(),
      },
    );
  }

  async onModuleDestroy() {
    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }
      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }
      this.logger.log('RabbitMQ connection closed');
    } catch (error) {
      this.logger.error('Error closing RabbitMQ connection', error);
    }
  }
}
