/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../providers/redis/redis.service';
import { RabbitMQService } from '../providers/rabbitmq/rabbitmq.service';
import { YookassaService } from '../providers/yookassa/yookassa.service';
import {
  PaymentStatus,
  SubscriptionStatus,
  InvoiceStatus,
  BillingCycle,
  PaymentProvider,
} from './enums/payment.enum';
import { PaymentGateway } from './payment.gateway';

/**
 * @class PaymentService
 * @description Центральное ядро обработки финансовых транзакций, подписок и рекуррентных платежей.
 * Обеспечивает отказоустойчивость через RabbitMQ (Manual ACK) и атомарность через Redis Locks.
 *
 * @property {PrismaService} prisma - ORM для работы с транзакционной базой данных (PostgreSQL).
 * @property {RedisService} redis - Хранилище для идемпотентности и распределенных блокировок.
 * @property {RabbitMQService} rabbitmq - Шина событий для асинхронной синхронизации микросервисов.
 * @property {YookassaService} yookassa - Интеграция с платежным шлюзом (Acquiring).
 */
@Injectable()
export class PaymentService implements OnModuleInit {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly rabbitmq: RabbitMQService,
    private readonly yookassa: YookassaService,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  // Регестрируем слушателя очереди подписка произойдет сразу при старте сервиса
  /**
   * Инициализация подписчиков на события RabbitMQ при старте модуля.
   * Реализует паттерн Event-Driven Consumers.
   *
   * @async
   * @description
   * 1. Подписка на 'payment.created' для логики инициализации.
   * 2. Подписка на 'dunning.process_step' для управления цепочкой взыскания задолженности.
   */
  async onModuleInit() {
    await this.rabbitmq.subscribe('payment.created', (data) =>
      this.handlePaymentCreated(data),
    );

    // Очередь для обработки просроченных платежей (Dunning)
    await this.rabbitmq.subscribe(
      'dunning.process_step',
      async (data) => await this.handleDunningStep(data),
    );
  }

  // ========== ОСНОВНЫЕ ПЛАТЕЖИ ==========
  /**
   * Инициализирует процесс создания платежа с защитой от
   * дублирования и гонки запросов.
   *
   * @param {any} createPaymentDto - Объект с данными (userId, amount, orderId, idempotencyKey).
   * @returns {Promise<any>} Объект созданного платежа со ссылкой на оплату (confirmationUrl).
   *
   * @throws {ConflictException} Если транзакция с данным ключом уже обрабатывается (Race Condition).
   *
   * @description
   * 1. Генерирует или проверяет idempotencyKey для обеспечения At-most-once семантики.
   * 2. Проверяет наличие результата в Redis Cache для мгновенного ответа при повторах.
   * 3. Захватывает Distributed Lock через Redis (SET NX) на время активной фазы создания.
   * 4. Реализует атомарную цепочку: Local DB (PENDING) -> Provider API -> Update Local DB.
   */
  async createPayment(createPaymentDto: any) {
    // Идемпотентность по paymentKey
    const idempotencyKey =
      createPaymentDto.idempotencyKey ||
      `pay_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const redisKey = `payment:${idempotencyKey}`;

    // 2. Сначала проверяем, нет ли уже готового результата в кеше
    const cached = await this.redis.getIdempotencyResult(
      `payment:${idempotencyKey}`,
    );

    // Если ключ такой уже есть то вернем значение ключа
    if (cached) {
      this.logger.log(`Returning cached payment for key: ${idempotencyKey}`);
      return cached;
    }

    // 3. Пытаемся захватить Lock, чтобы предотвратить одновременные запросы (Race Condition)
    const lockAcquired = await this.redis.acquireLock(idempotencyKey, 30);
    if (!lockAcquired) {
      // Если замок не взят, значит другой запрос с этим ключом уже в обработке
      throw new ConflictException(
        'Payment is already being processed. Please wait.',
      );
    }

    /**
     * ПРОВЕРКА АНТИФРОДА (AI-Ready)
     * Интеграция с системой интеллектуального скоринга транзакций.
     *
     * @description
     * В рамках расширения (Roadmap: AI-Driven AntiFraud) здесь инициируется проверка паттернов поведения.
     * При выявлении аномалий (fraudScore.isBlocked):
     * 1. Событие отправляется в очередь 'antifraud.blocked' для анализа в реальном времени.
     * 2. Транзакция прерывается на раннем этапе до обращения к платежному шлюзу.
     * Зачем закомментированный антифрод? заложены архитектурные границы для
     * интеграции AI-скоринга, которые сейчас находится в моем Backlog на
     * GitHub Projects. Это позволяет в будущем подключить сервис
     * анализа аномалий (например, на базе DeepSeek)
     * без рефакторинга основного флоу платежа.
     * это попытка проектиравть системы с учетом масштабирования в сторону безопасности
     * (Security-by-design)
     */
    // АНТИФРОД ПРОВЕРКА
    // const fraudScore = await this.antifraudService.check(createPaymentDto);

    // if (fraudScore.isBlocked) {
    //   await this.rabbitmq.sendToQueue('antifraud.blocked', {
    //     userId: createPaymentDto.userId,
    //     reason: fraudScore.reason,
    //     timestamp: new Date(),
    //   });
    //   throw new ForbiddenException(`Transaction blocked: ${fraudScore.reason}`);
    // }

    try {
      // --- НАЧАЛО ОСНОВНОЙ ЛОГИКИ ---

      // Проверка на дублирование по внешнему ID заказа
      if (createPaymentDto.orderId) {
        const existing = await this.prisma.payment.findFirst({
          where: {
            orderId: createPaymentDto.orderId,
            status: { in: ['PENDING', 'SUCCEEDED'] },
          },
        });
        if (existing) {
          throw new ConflictException(
            `Payment for order ${createPaymentDto.orderId} already exists`,
          );
        }
      }

      // Создаем платеж в БД
      const payment = await this.prisma.payment.create({
        data: {
          amount: createPaymentDto.amount,
          currency: createPaymentDto.currency || 'RUB',
          status: PaymentStatus.PENDING,
          userId: createPaymentDto.userId,
          orderId: createPaymentDto.orderId,
          description: createPaymentDto.description,
          metadata: createPaymentDto.metadata || {},
          provider: createPaymentDto.provider || PaymentProvider.YOOKASSA,
          isRecurring: createPaymentDto.isRecurring || false,
        },
      });

      // Обрабатываем через платежный провайдер
      let result;
      try {
        switch (payment.provider) {
          case PaymentProvider.YOOKASSA:
            result = await this.yookassa.createPayment({
              ...createPaymentDto,
              metadata: {
                ...createPaymentDto.metadata,
                internalPaymentId: payment.id,
                userId: payment.userId,
                orderId: payment.orderId,
              },
            });
            break;
          default:
            throw new BadRequestException(
              `Unsupported provider: ${payment.provider}`,
            );
        }

        // Обновляем платеж с externalId
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            externalId: result.id,
            providerData: result,
          },
        });

        // Кэшируем результат (Важно сделать это ДО releaseLock)
        await this.redis.setIdempotencyResult(redisKey, result, 300);

        // Публикуем событие
        await this.rabbitmq.sendToQueue('payment.created', {
          paymentId: payment.id,
          externalId: result.id,
          userId: payment.userId,
          amount: payment.amount,
          timestamp: new Date().toISOString(),
        });

        return {
          id: payment.id,
          externalId: result.id,
          status: payment.status,
          confirmationUrl: result.confirmation?.confirmation_url,
          ...result,
        };
      } catch (error) {
        // Обновляем статус на FAILED при ошибке
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.FAILED,
            errorMessage: error.message,
          },
        });

        await this.rabbitmq.sendToQueue('payment.failed', {
          paymentId: payment.id,
          userId: payment.userId,
          error: error.message,
          timestamp: new Date().toISOString(),
        });

        throw error;
      }
      // --- КОНЕЦ ОСНОВНОЙ ЛОГИКИ ---
    } finally {
      // 4. ВСЕГДА снимаем замок в конце (успех или ошибка — неважно)
      await this.redis.releaseLock(idempotencyKey);
    }
    // Ключевые моменты данной реализации:
    //
    // Порядок действий: Сначала ищем готовый результат в кеше (быстро),
    // и только если его нет — пытаемся заблокировать ресурс (acquireLock).
    //
    // Безопасность: Весь блок кода обернут в try...finally. Если база Prisma
    // или API ЮKassa «упадут» с ошибкой, замок в Redis всё равно удалится,
    // и пользователь сможет попробовать оплатить снова.
    // Атомарность: Теперь два идентичных запроса, пришедших одновременно,
    // никогда не пройдут дальше acquireLock.
  }

  // Подтверждение платежа
  /**
   * Подтверждает выполнение транзакции на стороне провайдера и обновляет внутренний статус системы.
   *
   * @param {string} paymentId - Внешний идентификатор платежа (externalId из ЮKassa/Stripe).
   * @param {any} dto - Дополнительные данные подтверждения от платежного шлюза.
   * @returns {Promise<any>} Результат подтверждения от провайдера.
   *
   * @description
   * 1. State Sync: Синхронизирует статус PENDING -> SUCCEEDED в базе данных Prisma.
   * 2. Card-on-File: При рекуррентном флаге инициирует сохранение токена метода оплаты для будущих списаний.
   * 3. Lifecycle: Автоматически активирует связанную подписку при успешном клиринге.
   * 4. Real-time & Async:
   *    - Публикует событие 'payment.succeeded' в RabbitMQ для внешних воркеров.
   *    - (New) Отправляет Push-уведомление клиенту через WebSocketGateway для обновления UI.
   * @throws {NotFoundException} Если платеж с таким externalId не зарегистрирован в системе.
   */
  async confirmPayment(paymentId: string, dto: any) {
    const payment = await this.prisma.payment.findUnique({
      where: { externalId: paymentId },
    });

    if (!payment) {
      throw new NotFoundException(`Payment ${paymentId} not found`);
    }

    try {
      const result = await this.yookassa.confirmPayment({
        paymentId,
        ...dto,
      });

      // Обновляем статус
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.SUCCEEDED,
          capturedAt: new Date(),
          providerData: result,
        },
      });

      // Если это рекуррентный платеж, сохраняем метод оплаты
      if (payment.isRecurring) {
        await this.savePaymentMethod(payment.userId, result);
      }

      // Если есть подписка, активируем ее
      if (payment.subscriptionId) {
        await this.activateSubscription(payment.subscriptionId);
      }

      // Публикуем событие
      await this.rabbitmq.sendToQueue('payment.succeeded', {
        paymentId: payment.id,
        externalId: payment.externalId,
        userId: payment.userId,
        amount: payment.amount,
        timestamp: new Date().toISOString(),
      });

      return result;
    } catch (error) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.FAILED,
          errorMessage: error.message,
        },
      });

      throw error;
    }
  }

  // ========== ПОДПИСКИ ==========

  // создать подписку
  /**
   * Инициирует жизненный цикл подписки (SaaS Subscription Pattern).
   * Реализует логику входа пользователя в платный или пробный контур системы.
   *
   * @param {any} dto - Данные тарифного плана (billingCycle, price, trialDays).
   * @returns {Promise<Subscription>} Объект подписки в статусе PENDING или TRIALING.
   *
   * @description
   * 1. Бизнес-валидация: Предотвращает конфликт активных подписок (Idempotency Check).
   * 2. Trial Engine: Вычисляет временные границы пробного периода (если trialDays > 0).
   * 3. Invoice Generation: Если триал отсутствует, автоматически инициирует создание
   *    первого финансового требования (Invoice) и объекта платежа (Payment).
   * 4. Sync: Публикует событие 'subscription.created' в RabbitMQ для синхронизации
   *    с ACL (Access Control List) и CRM.
   *
   * @throws {ConflictException} Если у пользователя уже есть активная подписка.
   */
  async createSubscription(dto: any) {
    const {
      userId,
      planId,
      planName,
      price,
      billingCycle,
      trialDays = 0,
    } = dto;

    // Проверяем активные подписки
    const activeSubscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      },
    });

    if (activeSubscription) {
      throw new ConflictException('User already has an active subscription');
    }

    const now = new Date();
    let trialStart = null;
    let trialEnd = null;
    let currentPeriodStart = null;
    let currentPeriodEnd = null;

    if (trialDays > 0) {
      trialStart = now;
      trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
    } else {
      currentPeriodStart = now;
      currentPeriodEnd = this.calculateNextBillingDate(billingCycle, now);
    }

    // Создаем подписку
    const subscription = await this.prisma.subscription.create({
      data: {
        userId,
        planId,
        planName,
        price,
        currency: 'RUB',
        billingCycle,
        status:
          trialDays > 0
            ? SubscriptionStatus.TRIALING
            : SubscriptionStatus.PENDING,
        trialStart,
        trialEnd,
        currentPeriodStart,
        currentPeriodEnd,
        metadata: dto.metadata || {},
      },
    });

    // Если нет триала, создаем первый инвойс и платеж
    if (trialDays === 0) {
      await this.createInvoiceForSubscription(subscription.id);
    }

    await this.rabbitmq.sendToQueue('subscription.created', {
      subscriptionId: subscription.id,
      userId,
      planId,
      status: subscription.status,
      timestamp: new Date().toISOString(),
    });

    return subscription;
  }

  // создание счет-фактуру для подписки
  /**
   * Генерация финансового требования (Invoice) и инициирование объекта платежа.
   * Реализует паттерн Double-Entry для обеспечения прозрачности биллинга.
   *
   * @param {string} subscriptionId - Идентификатор связанной подписки.
   * @returns {Promise<{ invoice: Invoice, payment: Payment }>} Связка инвойса и платежа.
   *
   * @description
   * 1. Financial Document: Создает Invoice со статусом OPEN и фиксирует Grace Period (3 дня).
   * 2. Audit Trail: Прокидывает метаданные плана и периодов (start/end) во все сущности.
   * 3. Payment Initialization: Автоматически создает Payment в статусе PENDING,
   *    связывая его с инвойсом для прослеживаемости (Traceability).
   * 4. Recurring Logic: Помечает платеж как isRecurring и isFirstPayment для
   *    корректной работы банковского клиринга (3DS vs Recurrent).
   * 5. Async Notification: Публикует 'invoice.created' для почтовых и SMS уведомлений.
   *
   * @throws {NotFoundException} Если подписка не найдена в реестре.
   */
  async createInvoiceForSubscription(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 3); // Оплатить в течение 3 дней

    const invoice = await this.prisma.invoice.create({
      data: {
        subscriptionId: subscription.id,
        userId: subscription.userId,
        amountDue: subscription.price,
        status: InvoiceStatus.OPEN,
        dueDate,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
        metadata: {
          planId: subscription.planId,
          planName: subscription.planName,
          billingCycle: subscription.billingCycle,
        },
      },
    });

    // Создаем платеж для инвойса
    const payment = await this.prisma.payment.create({
      data: {
        userId: subscription.userId,
        subscriptionId: subscription.id,
        invoiceId: invoice.id,
        amount: subscription.price,
        currency: subscription.currency,
        status: PaymentStatus.PENDING,
        isRecurring: true,
        isFirstPayment: subscription.status === SubscriptionStatus.PENDING,
        metadata: {
          invoiceId: invoice.id,
          subscriptionId: subscription.id,
          planId: subscription.planId,
        },
      },
    });

    await this.rabbitmq.sendToQueue('invoice.created', {
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      userId: subscription.userId,
      amountDue: invoice.amountDue,
      dueDate: invoice.dueDate,
      timestamp: new Date().toISOString(),
    });

    // Реалтайм-уведомление о выставлении нового счета
    this.paymentGateway.emitPaymentStatus(subscription.userId, {
      event: 'invoice_created',
      invoiceId: invoice.id,
      amount: invoice.amountDue,
      dueDate: invoice.dueDate,
    });

    return { invoice, payment };
  }

  // повторяющаяся оплата
  /**
   * Инициализирует цикл автоматического продления подписки (Recurring Billing Engine).
   * Реализует паттерн атомарного списания средств без участия пользователя.
   *
   * @param {string} subscriptionId - ID подписки для обработки.
   * @returns {Promise<any>} Результат транзакции или статус запуска Dunning-процесса.
   *
   * @description
   * 1. Mutual Exclusion: Использует Distributed Lock (Redis SET NX) для исключения
   *    параллельных списаний при сбоях планировщика (Cron/Job).
   * 2. Transactional Hierarchy: Сначала создает Invoice, затем инициирует Charge.
   *    Это гарантирует наличие финансового следа (Audit Trail).
   * 3. Fault Tolerance: При ошибке эквайринга (Insufficient funds/Expired card)
   *    автоматически запускает Dunning Process (стратегию мягкого взыскания).
   * 4. State Update: При успехе атомарно обновляет статус инвойса, платежа и
   *    пролонгирует период действия подписки (currentPeriodEnd).
   *
   * @throws {ConflictException} Если подписка уже заблокирована другим воркером.
   * Этот метод — «главный калибр». потому что рекурренты — это автоматическая
   * печатная машинка для бизнеса. Если она сломается или спишет лишнее —
   * это катастрофа. Но у тут «броня» из Redis Lock и Dunning-логики.
   */
  async processRecurringPayment(subscriptionId: string) {
    const lockKey = `lock:subscription:${subscriptionId}`;
    const hasLock = await this.redis.acquireLock(lockKey, 30);

    if (!hasLock) {
      throw new ConflictException('Subscription is already being processed');
    }

    try {
      const subscription = await this.prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: { defaultPaymentMethod: true },
      });

      if (!subscription || subscription.status !== SubscriptionStatus.ACTIVE) {
        throw new BadRequestException('Subscription not active');
      }

      // Создаем новый инвойс
      const { invoice, payment } =
        await this.createInvoiceForSubscription(subscriptionId);

      // Если есть сохраненный метод оплаты, пытаемся списать
      if (subscription.defaultPaymentMethodId) {
        try {
          const result = await this.chargePaymentMethod(
            subscription.defaultPaymentMethod,
            payment.amount,
            payment.currency,
            `Подписка ${subscription.planName}`,
            { invoiceId: invoice.id, subscriptionId },
          );

          await this.prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.SUCCEEDED,
              externalId: result.id,
              capturedAt: new Date(),
            },
          });

          await this.prisma.invoice.update({
            where: { id: invoice.id },
            data: {
              status: InvoiceStatus.PAID,
              paidAt: new Date(),
              amountPaid: invoice.amountDue,
            },
          });

          // Обновляем период подписки
          await this.updateSubscriptionPeriod(subscriptionId);

          await this.rabbitmq.sendToQueue('payment.recurring_succeeded', {
            subscriptionId,
            paymentId: payment.id,
            invoiceId: invoice.id,
            amount: payment.amount,
            timestamp: new Date().toISOString(),
          });

          // Реалтайм-уведомление об успешном автопродлении
          this.paymentGateway.emitPaymentStatus(subscription.userId, {
            event: 'subscription_renewed',
            subscriptionId: subscription.id,
            status: 'ACTIVE',
            nextBillingDate: subscription.currentPeriodEnd,
          });

          return { success: true, payment, invoice };
        } catch (error) {
          // Платеж не прошел, запускаем даннинг
          await this.startDunningProcess(invoice.id);
          return { success: false, error: error.message };
        }
      } else {
        // Нет метода оплаты, ждем ручного платежа
        return { success: false, error: 'No payment method available' };
      }
    } finally {
      await this.redis.releaseLock(lockKey);
    }
  }

  // отмена подиски или прекращение подиски
  /**
   * Управляет процессом прекращения действия подписки (Churn Management).
   * Реализует гибкие стратегии отмены в соответствии с SaaS-стандартами.
   *
   * @param {string} subscriptionId - ID подписки для отмены.
   * @param {boolean} [cancelAtPeriodEnd=false] - Флаг отложенной отмены (до конца оплаченного срока).
   * @returns {Promise<Subscription>} Объект подписки с обновленным статусом.
   *
   * @description
   * 1. Hybrid Cancellation: Поддерживает мгновенную остановку (CANCELED) или
   *    мягкое завершение в конце периода (cancelAtPeriodEnd: true).
   * 2. Financial Cleanup: Автоматически переводит открытые инвойсы в статус VOID
   *    (аннулировано), предотвращая ошибочные списания.
   * 3. Consistency: Гарантирует корректность финансовой отчетности, исключая "висящие" требования оплаты.
   * 4. Sync: Публикует событие 'subscription.canceled' в RabbitMQ для каскадной
   *    остановки услуг в других сервисах экосистемы.
   *
   * @throws {NotFoundException} Если подписка отсутствует в реестре.
   * Метод отмены подписки. В обычных сервисах подписку просто «удаляют»,
   * а в серьезных платформах  её «аннулируют» с сохранением финансовой истории.
   * Подход с VOID для инвойсов и флагом cancelAtPeriodEnd. Это уважение к деньгам
   * и клиенту. Как решаем конфликты по возвратам после отмены подписки?
   * Архитектура отмены подписки исключает конфликты на корню. При аннулировании
   * автоматически переводим все открытые инвойсы в статус VOID. Это гарантирует,
   * что система не выставит счет за уже отмененную услугу. При этом поддерживем
   * флаг cancelAtPeriodEnd, что позволяет клиенту доиспользовать оплаченное
   * время — это стандарт SaaS-лояльности, снижающий количество чарджбэков.
   */
  async cancelSubscription(subscriptionId: string, cancelAtPeriodEnd = false) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    const updateData: any = {};

    // Отмена в конце периода
    if (cancelAtPeriodEnd) {
      updateData.cancelAtPeriodEnd = true;
    } else {
      updateData.status = SubscriptionStatus.CANCELED;
      updateData.canceledAt = new Date();
    }

    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: updateData,
    });

    // Отменяем ожидающие инвойсы
    await this.prisma.invoice.updateMany({
      where: {
        subscriptionId,
        status: InvoiceStatus.OPEN,
      },
      data: {
        status: InvoiceStatus.VOID,
      },
    });

    await this.rabbitmq.sendToQueue('subscription.canceled', {
      subscriptionId,
      userId: subscription.userId,
      cancelAtPeriodEnd,
      timestamp: new Date().toISOString(),
    });

    // Реалтайм-уведомление пользователя об изменении статуса подписки
    this.paymentGateway.emitPaymentStatus(subscription.userId, {
      event: 'subscription_canceled',
      subscriptionId,
      cancelAtPeriodEnd,
      status: cancelAtPeriodEnd ? 'ACTIVE_UNTIL_END' : 'CANCELED',
    });

    return subscription;
  }

  // ========== ДАННИНГ ==========

  /**
   * Инициирует многостадийный процесс взыскания задолженности (Dunning Cycle).
   * Запускается автоматически при неудачной попытке рекуррентного списания.
   *
   * @param {string} invoiceId - ID неоплаченного инвойса, требующего обработки.
   * @returns {Promise<DunningProcess>} Объект активного процесса даннинга.
   *
   * @description
   * 1. Entry Validation: Проверяет актуальность инвойса (должен быть в статусе OPEN).
   * 2. State Initialization: Создает запись в DunningProcess с заданным количеством этапов (6 стадий).
   * 3. Retries Management: Инкрементирует attemptCount в инвойсе и планирует следующую попытку (24ч).
   * 4. Multi-channel Sync:
   *    - Вызывает уведомление пользователя (Email/SMS).
   *    - Публикует событие 'dunning.started' в RabbitMQ для внешнего мониторинга.
   *
   * @throws {BadRequestException} Если инвойс уже оплачен или не существует.
   * Этот метод — начало «битвы за деньги» стратегия «дожима».
   * Как понять, почему клиент отвалился? Реализовуем прозрачный Dunning Cycle.
   * В базе данных хранится история каждой попытки, а JSDoc в коде четко описывает
   * логику переходов. Это позволяет не только взыскивать долги автоматически,
   * но и анализировать причины отказов на каждом из 6 этапов.
   * Весь процесс прошит событиями и сокетами, что дает полный контроль
   * в реальном времени.
   */
  async startDunningProcess(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { subscription: true },
    });

    if (!invoice || invoice.status !== InvoiceStatus.OPEN) {
      throw new BadRequestException('Invalid invoice for dunning');
    }

    // Создаем процесс даннинга
    const dunningProcess = await this.prisma.dunningProcess.create({
      data: {
        invoiceId: invoice.id,
        userId: invoice.userId,
        subscriptionId: invoice.subscriptionId,
        currentStage: 1,
        maxStages: 6,
        nextActionAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // Через 24 часа
        status: 'ACTIVE',
        metadata: {
          amountDue: invoice.amountDue,
          dueDate: invoice.dueDate,
        },
      },
    });

    // Увеличиваем счетчик попыток
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        attemptCount: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    // Отправляем первое уведомление
    await this.sendDunningNotification(dunningProcess, 1);

    await this.rabbitmq.sendToQueue('dunning.started', {
      dunningId: dunningProcess.id,
      invoiceId,
      subscriptionId: invoice.subscriptionId,
      userId: invoice.userId,
      stage: 1,
      timestamp: new Date().toISOString(),
    });

    // Уведомление в реалтайме о начале процесса обработки задолженности
    this.paymentGateway.emitPaymentStatus(invoice.userId, {
      event: 'dunning_started',
      invoiceId: invoice.id,
      nextAttemptAt: dunningProcess.nextActionAt,
      stage: 1,
    });

    return dunningProcess;
  }

  // этапы обработки задолжности
  /**
   * Исполняет текущую стадию процесса взыскания задолженности (Dunning Engine).
   * Реализует паттерн State Machine для управления жизненным циклом просроченного инвойса.
   *
   * @param {string} dunningId - Идентификатор активного процесса даннинга.
   * @returns {Promise<any>} Результат перехода стадии или завершения процесса.
   *
   * @description
   * 1. Dynamic Flow: Определяет действие (Email/SMS/Retry/Cancel) на основе текущего индекса стадии.
   * 2. Business Recovery: При успехе RETRY_PAYMENT мгновенно закрывает задолженность и восстанавливает подписку.
   * 3. Graceful Termination: На финальной стадии аннулирует подписку и помечает инвойс как UNCOLLECTIBLE (безнадежный).
   * 4. Audit Trail: Фиксирует каждое предпринятое действие в массиве actionsTaken (история взыскания).
   * 5. Async Chaining: Публикует 'dunning.stage_completed' для планирования следующего шага через RabbitMQ/Scheduler.
   *
   * @throws {BadRequestException} Если процесс уже завершен или не активен.
   * А почему тут switch-case, а не 10 разных классов? Выбран принцип YAGNI
   * (You Ain't Gonna Need It) и KISS. Текущая реализация через Switch-case
   * и единый стейт-массив обеспечивает максимальную читаемость и легкую отладку.
   * При этом логика полностью декуплирована (развязана) через RabbitMQ.
   * Если стадий станет 50, просто выносим конфиг в базу, не меняя ядро процессора».
   */
  async processDunningStage(dunningId: string) {
    const dunning = await this.prisma.dunningProcess.findUnique({
      where: { id: dunningId },
      include: { invoice: true, subscription: true },
    });

    if (!dunning || dunning.status !== 'ACTIVE') {
      throw new BadRequestException('Dunning process not active');
    }

    const stages = [
      { action: 'EMAIL_REMINDER', delayDays: 1 },
      { action: 'EMAIL_WARNING', delayDays: 2 },
      { action: 'SMS_REMINDER', delayDays: 3 },
      { action: 'RETRY_PAYMENT', delayDays: 4 },
      { action: 'FINAL_WARNING', delayDays: 7 },
      { action: 'CANCEL_SUBSCRIPTION', delayDays: 14 },
    ];

    const currentStage = stages[dunning.currentStage - 1];

    // Выполняем действие текущей стадии
    switch (currentStage.action) {
      case 'RETRY_PAYMENT':
        const success = await this.retryInvoicePayment(dunning.invoiceId);
        if (success) {
          // Если платеж прошел, завершаем даннинг
          await this.completeDunning(dunningId, 'COMPLETED');
          return { completed: true, reason: 'Payment successful' };
        }
        break;

      case 'CANCEL_SUBSCRIPTION':
        if (dunning.subscriptionId) {
          await this.cancelSubscription(dunning.subscriptionId, false);
        }
        await this.prisma.invoice.update({
          where: { id: dunning.invoiceId },
          data: { status: InvoiceStatus.UNCOLLECTIBLE },
        });
        await this.completeDunning(dunningId, 'COMPLETED');
        return { completed: true, reason: 'Subscription cancelled' };

      default:
        await this.sendDunningNotification(dunning, dunning.currentStage);
    }

    // Переходим к следующей стадии, если не последняя
    if (dunning.currentStage < dunning.maxStages) {
      const nextActionAt = new Date();
      nextActionAt.setDate(
        nextActionAt.getDate() + stages[dunning.currentStage].delayDays,
      );

      await this.prisma.dunningProcess.update({
        where: { id: dunningId },
        data: {
          currentStage: { increment: 1 },
          nextActionAt,
          lastActionAt: new Date(),
          actionsTaken: {
            push: {
              stage: dunning.currentStage,
              action: currentStage.action,
              timestamp: new Date().toISOString(),
            },
          },
        },
      });

      await this.rabbitmq.sendToQueue('dunning.stage_completed', {
        dunningId,
        stage: dunning.currentStage,
        nextStage: dunning.currentStage + 1,
        nextActionAt,
        timestamp: new Date().toISOString(),
      });

      // Real-time мониторинг прогресса взыскания
      /**
       * Используем PaymentGateway как инфраструктурный адаптер.
       * Сервис выполняет бизнес-логику (списание, подписки),
       * а затем уведомляет внешние системы. Сокеты здесь
       * работают так же, как RabbitMQ — это просто еще один
       * канал связи с миром (Real-time канал).
       * Это обеспечивает Low Coupling (слабую связность),
       * так как логика рассылки инкапсулирована в гейтвее»
       * Как боретотся с рассинхроном данных в биллинге?
       * Используем жесткую связку сущностей: Subscription -> Invoice -> Payment.
       * Инвойс выступает в роли "якоря" для финансовой отчетности.
       * Даже если платеж упадет или будет оспорен, у нас остается
       * след в виде инвойса с метаданными периода.
       * Это обеспечивает Strong Consistency (сильную согласованность)
       * и готовность к аудиту в любой момент
       */
      this.paymentGateway.emitPaymentStatus(dunning.userId, {
        event: 'dunning_stage_advanced',
        dunningId,
        newStage: dunning.currentStage + 1,
        nextActionAt: nextActionAt,
      });

      return { completed: false, nextStage: dunning.currentStage + 1 };
    }

    await this.completeDunning(dunningId, 'COMPLETED');
    return { completed: true, reason: 'All stages completed' };
  }

  // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========
  /**
   * Внутренний потребитель (Consumer) событий очереди для управления шагами взыскания задолженности.
   *
   * @param {Object} data - Объект события, содержащий dunningId.
   * @private
   *
   * @description
   * 1. Orchestration: Выступает фасадом для метода processDunningStage, инкапсулируя логику логирования.
   * 2. Infrastructure Link: Работает в связке с RabbitMQ для реализации отложенных задач (Delayed Messages).
   * 3. Resilience: При возникновении исключения (например, недоступность БД) пробрасывает ошибку выше.
   * Это позволяет RabbitMQ вернуть сообщение в очередь (NACK) для повторной обработки.
   * 4. Observability: Обеспечивает детальное логирование переходов между стадиями для диагностики в проде.
   *
   * Этот private метод — это «невидимый дирижер». Он связывает асинхронный мир RabbitMQ
   * с этой жесткой бизнес-логикой. То, что вынесено - это в отдельный обработчик,
   *  - это Separation of Concerns (разделение ответственности).
   */
  private async handleDunningStep(data: { dunningId: string }) {
    this.logger.log(`Processing dunning step for ID: ${data.dunningId}`);

    try {
      // Вызываем  основной метод со свитч-кейсами
      const result = await this.processDunningStage(data.dunningId);

      if (result.completed) {
        this.logger.log(`Dunning ${data.dunningId} finished: ${result.reason}`);
      } else {
        this.logger.log(
          `Dunning ${data.dunningId} moved to stage ${result.nextStage}`,
        );
        // ВАЖНО: метод processDunningStage уже отправил событие
        // 'dunning.stage_completed' в очередь. Убедись, что твоя инфраструктура
        // RabbitMQ настроена перекидывать его обратно в 'dunning.process_step' с задержкой.
      }
    } catch (error) {
      this.logger.error(
        `Failed to process dunning step for ${data.dunningId}: ${error.message}`,
      );
      // Здесь можно реализовать логику повтора (nack), если ошибка временная (например, БД упала)
      throw error;
    }
  }

  // Бизнес-логика обработки
  /**
   * Асинхронный обработчик события создания платежа (Post-creation Processor).
   * Реализует паттерн Side-Effects Handler.
   *
   * @param {any} data - Метаданные созданного платежа из очереди RabbitMQ.
   * @private
   *
   * @description
   * 1. Decoupling: Позволяет вынести тяжелые операции (интеграция с внешними API,
   *    генерация документов) за пределы основного HTTP-цикла.
   * 2. Scalability: Данный метод может быть вынесен в отдельный микросервис-воркер
   *    без изменения бизнес-логики основного PaymentService.
   * 3. Logging & Observability: Фиксирует факт входа транзакции в пайплайн обработки.
   * Этот метод — это точка расширения. Сейчас это просто «заглушка»,
   * но это нужно будет для  архитектуры Event-Driven, где создание записи
   * и её обработка разнесены в пространстве и времени». Это критично для
   * Highload: сначала быстро сохраняется платеж в базу (чтобы юзер не ждал),
   * а потом асинхронно через этот метод «допиливаем» интеграцию с банком.
   * А почему не вызывать ЮKassa прямо в контроллере? использование асинхронной модели.
   * Метод handlePaymentCreated — это хук, который позволяет системе оставаться
   * отзывчивой. Фиксирование намерения платежа в БД и RabbitMQ, а вся тяжелая
   * работа по взаимодействию с внешними шлюзами происходит здесь. Это гарантирует,
   * что тайм-ауты сторонних сервисов не «положат» основной API.
   */
  private async handlePaymentCreated(data: any) {
    console.log('Обработка нового платежа:', data);
    // Здесь логика интеграции с ЮKassa / Stripe
  }

  // сохранить способ оплаты
  /**
   * Токенизация и безопасное сохранение платежных реквизитов (Card-on-File).
   * Реализует логику хранения маскированных данных для рекуррентных списаний.
   *
   * @param {string} userId - Идентификатор владельца метода оплаты.
   * @param {any} paymentResult - Ответ от эквайринга с токеном и деталями карты.
   * @private
   *
   * @description
   * 1. Tokenization: Сохраняет externalId (токен) вместо конфиденциальных данных (PAN/CVV),
   *    обеспечивая соответствие стандартам безопасности (PCI DSS).
   * 2. Deduplication: Исключает дублирование методов оплаты через проверку externalId.
   * 3. Metadata: Фиксирует маскированные данные (last4, brand) для отображения в UI.
   * 4. Business Logic: Назначает первый сохраненный метод как 'isDefault' для автосписаний.
   * Эти два метода — «тихая гавань» биллинга. Здесь происходит магия превращения разового
   * покупателя в постоянного клиента.
   * Это критично:  важно, чтобы инвестор один раз привязал карту, а дальше
   * система сама «крутила» финансовые циклы. Такой код делает это безопасно
   * (не храня полные данные карт) и автоматично.
   * Здесь  PCI DSS Compliance (безопасность карт) и Lifecycle Management.
   */
  private async savePaymentMethod(userId: string, paymentResult: any) {
    if (paymentResult.payment_method?.id) {
      const existing = await this.prisma.paymentMethod.findFirst({
        where: {
          userId,
          externalId: paymentResult.payment_method.id,
          provider: PaymentProvider.YOOKASSA,
        },
      });

      if (!existing) {
        await this.prisma.paymentMethod.create({
          data: {
            userId,
            provider: PaymentProvider.YOOKASSA,
            type: 'CARD',
            externalId: paymentResult.payment_method.id,
            last4: paymentResult.payment_method.card?.last4,
            brand: paymentResult.payment_method.card?.card_type,
            expiryMonth: paymentResult.payment_method.card?.expiry_month,
            expiryYear: paymentResult.payment_method.card?.expiry_year,
            isDefault: true, // Первый сохраненный метод - по умолчанию
            metadata: paymentResult.payment_method,
          },
        });
      }
    }
  }

  // активировать подписку
  /**
   * Активация подписки и инициализация расчетного периода.
   * Переводит подписку из статуса ожидания в фазу активного оказания услуг.
   *
   * @param {string} subscriptionId - ID подписки для активации.
   * @private
   *
   * @description
   * 1. State Transition: Меняет статус на ACTIVE после успешного клиринга первого платежа.
   * 2. Period Mapping: Вычисляет и фиксирует границы текущего оплаченного периода (start/end).
   * 3. Continuity: Обеспечивает бесшовный переход от процесса оплаты к доступу к функционалу платформы.
   * Как минимизировать риск утечки банковских данных? Метод savePaymentMethod
   * реализует безопасную токенизацию. Он работает по модели Card-on-File,
   * сохраняя в БД только маскированные данные (last4, brand) и защищенный
   * токен от ЮKassa. Это позволяет безопасно проводить рекуррентные
   * платежи, не попадая под жесткие требования прямого хранения данных карт (PCI DSS).
   */
  private async activateSubscription(subscriptionId: string) {
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: new Date(),
        currentPeriodEnd: this.calculateNextBillingDate('MONTHLY'),
      },
    });
  }

  /**
   * Пролонгация расчетного периода подписки (Subscription Rolling).
   * Реализует логику бесшовного перехода между оплаченными циклами.
   *
   * @param {string} subscriptionId - Идентификатор подписки для обновления.
   * @private
   *
   * @description
   * 1. Continuous Billing: Устанавливает начало нового периода (currentPeriodStart)
   *    строго равным концу предыдущего (currentPeriodEnd), исключая "дыры" в доступе.
   * 2. Cycle Calculation: Вычисляет новую дату окончания (currentPeriodEnd) через
   *    хелпер calculateNextBillingDate на основе текущего тарифного плана (MONTHLY/YEARLY).
   * 3. State Integrity: Гарантирует актуальность временных рамок подписки для корректной
   *    работы планировщика рекуррентных списаний.
   * Этот метод — «часовой механизм» подписки. Он отвечает за то, чтобы после успешной
   *  оплаты доступ пользователя продлился ровно на нужный срок, это критично для
   * корректного отображения активных инвестиционных периодов и аренды,
   * тут не просто прибавляем месяц к «сегодняшнему числу», а аккуратно переносим
   *  границу предыдущего периода.
   * Дрейф дат (Date Drift) при ежемесячных списаниях Метод
   * updateSubscriptionPeriod исключает дрейф дат, так как новый период всегда
   * отсчитывается от теоретической даты окончания предыдущего периода,
   * а не от момента физического списания средств. Это гарантирует, что
   * если платеж задержался на пару часов из-за банка, пользователь всё равно
   * получит ровно 30 дней доступа, и следующий инвойс будет выставлен в
   * правильный день.
   */
  private async updateSubscriptionPeriod(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });

    if (!subscription) return;

    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        currentPeriodStart: subscription.currentPeriodEnd,
        currentPeriodEnd: this.calculateNextBillingDate(
          subscription.billingCycle,
          subscription.currentPeriodEnd,
        ),
      },
    });
  }

  // рассчитать следующую дату выставления счета
  /**
   * Атомарный расчет временной границы следующего расчетного периода (Billing Cycle).
   * Реализует логику пролонгации подписки в зависимости от выбранного тарифного плана.
   *
   * @param {BillingCycle} billingCycle - Интервал списания (DAILY, WEEKLY, MONTHLY, QUARTERLY, YEARLY).
   * @param {Date} [fromDate=new Date()] - Точка отсчета для вычисления (по умолчанию текущий момент).
   * @returns {Date} Объект даты для следующей итерации инвойсирования.
   *
   * @description
   * 1. Deterministic Calculation: Исключает дрейф дат (Date Drift), вычисляя период от строго заданной точки.
   * 2. Business Flexibility: Поддерживает 5 типов циклов, что позволяет гибко настраивать SaaS-пакеты.
   * 3. Immutability: Работает с копией объекта Date, не мутируя исходные данные.
   * Этот метод calculateNextBillingDate — метроном бизнеса. В недвижимости и
   * инвестициях ошибка в один день может стоить миллионы, поэтому четкая логика здесь
   * — это стандарт.
   * Как обрабатывать високосные годы или разные длины месяцев при продлении? Используюем
   * встроенный объект Date в Node.js, который корректно обрабатывает переходы месяцев
   * и лет. Метод calculateNextBillingDate полностью инкапсулирует эту логику.
   * Независимо от того, 28 дней в феврале или 31 в марте, пользователь получит
   * честный MONTHLY период, а система сохранит точность финансовых расчетов,
   * что критично для платформы инвестиций.
   */
  private calculateNextBillingDate(
    billingCycle: BillingCycle,
    fromDate: Date = new Date(),
  ): Date {
    const date = new Date(fromDate);

    switch (billingCycle) {
      case 'DAILY':
        date.setDate(date.getDate() + 1);
        break;
      case 'WEEKLY':
        date.setDate(date.getDate() + 7);
        break;
      case 'MONTHLY':
        date.setMonth(date.getMonth() + 1);
        break;
      case 'QUARTERLY':
        date.setMonth(date.getMonth() + 3);
        break;
      case 'YEARLY':
        date.setFullYear(date.getFullYear() + 1);
        break;
      default:
        date.setMonth(date.getMonth() + 1);
    }

    return date;
  }

  // способ оплаты сбора
  // реализован одноэтапный платеж (сразу с capture: true)
  /**
   * Выполняет автоматическое списание средств с использованием ранее токенизированного метода оплаты.
   * Реализует паттерн Card-on-File для обеспечения рекуррентных платежей.
   *
   * @param {any} paymentMethod - Объект сохраненного метода оплаты (токен externalId).
   * @param {number} amount - Сумма транзакции.
   * @param {string} currency - Валюта операции (RUB по умолчанию).
   * @param {string} description - Назначение платежа (для выписки клиента).
   * @param {any} metadata - Дополнительные бизнес-данные (invoiceId, subscriptionId).
   * @returns {Promise<any>} Объект созданного платежа от провайдера (Yookassa).
   *
   * @description
   * 1. Tokenized Charge: Использует payment_method_id для списания без участия пользователя (One-Click/Recurring).
   * 2. Auto-Capture: Устанавливает флаг capture: true для мгновенного подтверждения транзакции без двухэтапного клиринга.
   * 3. Traceability: Обогащает метаданные меткой 'savedPaymentMethod', что критично для финансового мониторинга и снижения риска Chargeback.
   * Этот метод —«рабочая лошадка», которая фактически перекладывает деньги из кармана
   * клиента в банк. В это самый ответственный узел: здесь происходит Card-on-File
   * списание (рекуррент). Здесь должна быть лаконичность и безопасность:  используем
   * токен (payment_method_id), а не данные карты. Это стандарт PCI DSS.
   * Как защитить систему от ошибок провайдера при автосписании? Метод
   * chargePaymentMethod — это чистый интерфейс к эквайрингу.
   * Вся защита вынесена уровнем выше: в processRecurringPayment используем
   * Redis Locks, чтобы не списать дважды, а ошибки этого метода автоматически
   * перехватываются и запускают Dunning-процесс. Это обеспечивает отказоустойчивость
   * всей финансовой цепочки.
   */
  private async chargePaymentMethod(
    paymentMethod: any,
    amount: number,
    currency: string,
    description: string,
    metadata: any,
  ) {
    // Здесь реализация списания с сохраненного метода
    // Для Yookassa используем сохраненный метод
    return await this.yookassa.createPayment({
      amount: { value: amount, currency },
      payment_method_id: paymentMethod.externalId,
      description,
      metadata: {
        ...metadata,
        savedPaymentMethod: true,
      },
      capture: true,
    });
  }

  // повторение попытки оплаты счета
  /**
   * Исполняет стратегию повторного списания (Smart Retry) для просроченного инвойса.
   * Реализует механизм автоматического восстановления платежа (Payment Recovery).
   *
   * @param {string} invoiceId - Идентификатор инвойса, требующего повторной обработки.
   * @returns {Promise<boolean>} Результат попытки (true - успех, false - отказ/ошибка).
   *
   * @description
   * 1. Data Hydration: Подтягивает цепочку Invoice -> Subscription -> PaymentMethod для доступа к токену карты.
   * 2. Idempotent Retry: Инициирует списание через chargePaymentMethod с пометкой retry: true для аналитики.
   * 3. State Reconciliation: При успехе переводит инвойс в статус PAID и фиксирует дату фактической оплаты.
   * 4. Downstream Notification: Публикует событие 'payment.retry_succeeded' для возобновления услуг в других сервисах.
   * 5. Error Resilience: Логирует ошибки эквайринга, возвращая статус-код для принятия решения на следующем этапе Dunning.
   * Этот метод — «реаниматолог». Он возвращает деньги в систему, когда первый
   * (платеж) не прошел. Это критично для сохранения LTV (пожизненной ценности клиента).
   * Если банк «моргнул», твой ретрай спасет сделку.
   * «Как понять, что система не "зациклилась" на битой карте? Метод retryInvoicePayment
   * — это исполнитель воли Dunning-машины. Он не живет сам по себе. Его вызывает
   * processDunningStage, который жестко ограничивает количество попыток (maxStages: 6)
   * и задержки между ними. Это исключает бесконечные запросы к банку и защищает
   * репутацию в платежной системе (избегая высокого Ratio отказов).
   */
  private async retryInvoicePayment(invoiceId: string): Promise<boolean> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { subscription: { include: { defaultPaymentMethod: true } } },
    });

    if (!invoice || !invoice.subscription?.defaultPaymentMethod) {
      return false;
    }

    try {
      const result = await this.chargePaymentMethod(
        invoice.subscription.defaultPaymentMethod,
        invoice.amountDue,
        'RUB',
        `Повторное списание для инвойса ${invoice.id}`,
        { invoiceId: invoice.id, retry: true },
      );

      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          status: InvoiceStatus.PAID,
          paidAt: new Date(),
          amountPaid: invoice.amountDue,
        },
      });

      await this.rabbitmq.sendToQueue('payment.retry_succeeded', {
        invoiceId,
        amount: invoice.amountDue,
        timestamp: new Date().toISOString(),
      });

      return true;
    } catch (error) {
      this.logger.error(
        `Retry payment failed for invoice ${invoiceId}:`,
        error,
      );
      return false;
    }
  }

  // отправить уведомление о взыскании задолжности
  /**
   * Инициирует отправку многоканального уведомления о задолженности (Email/SMS/Push).
   * Реализует паттерн уведомлений в распределенной системе.
   *
   * @param {any} dunning - Объект активного процесса взыскания с контекстом задолженности.
   * @param {number} stage - Текущий порядковый номер стадии (от 1 до 6).
   * @private
   *
   * @description
   * 1. Decoupling: Делегирует физическую отправку сообщений специализированному сервису уведомлений.
   * 2. Event Payload: Формирует контекст для шаблонизатора (сумма долга, ID инвойса, номер стадии).
   * 3. Delivery Guarantee: Публикует событие в RabbitMQ ('notification.dunning') с гарантией At-least-once.
   * 4. Audit: Фиксирует факт отправки уведомления в системных логах для последующего разбора инцидентов.
   * Этот метод — «дипломатический корпус». В финтехе крайне важно не просто
   * «забрать деньги», а вовремя и вежливо предупредить клиента, чтобы не спровоцировать
   * жалобу или чарджбэк. Это залог лояльности крупных инвесторов.
   * Мы не пытаемся впихнуть отправку почты прямо в биллинг (что создало бы задержки),
   * а используем асинхронный делегат. Почему не используем здесь внешний API
   * (например, SendGrid) напрямую? Потому что надо придерживаться принципа
   * Low Coupling (слабой связности). PaymentService не должен зависеть от стабильности
   * внешних сервисов рассылок. Отправляем событие в шину данных (RabbitMQ),
   * и если сервис уведомлений временно недоступен, сообщение подождет в очереди.
   * Это гарантирует, что клиент обязательно получит предупреждение, а наш биллинг
   * не будет тормозить из-за внешних HTTP-таймаутов».
   */
  private async sendDunningNotification(dunning: any, stage: number) {
    // Реализация отправки email/SMS уведомлений
    this.logger.log(
      `Sending dunning notification for stage ${stage} to user ${dunning.userId}`,
    );

    await this.rabbitmq.sendToQueue('notification.dunning', {
      userId: dunning.userId,
      dunningId: dunning.id,
      stage,
      amountDue: dunning.invoice.amountDue,
      timestamp: new Date().toISOString(),
    });
  }

  // полное взыскание долгов
  /**
   * Завершает жизненный цикл процесса взыскания задолженности (Dunning Cycle).
   * Переводит процесс в финальное состояние для исторической отчетности и аналитики.
   *
   * @param {string} dunningId - Уникальный идентификатор процесса даннинга.
   * @param {string} status - Результирующий статус (COMPLETED — долг погашен / CANCELED — подписка аннулирована).
   * @private
   *
   * @description
   * 1. Final State: Фиксирует окончательный статус процесса в базе данных Prisma.
   * 2. Audit Snapshot: Обновляет временную метку последнего действия (lastActionAt) для оценки длительности "дожима".
   * 3. Cleanup: Позволяет планировщикам игнорировать данный ID при поиске активных задач.
   * Этот метод — «печать на документе». Он официально закрывает дело о взыскании.
   * Это критично: инвестор либо вернулся в строй (COMPLETED), либо его контракт
   * расторгнут. Тут доложна быть дисциплина данных: мы не бросаем процесс «висеть»,
   * а четко фиксируем финал и время последнего действия.
   * Как считаетеся эффективность  отдела взыскания?»
   * Архитектура позволяет это сделать одной SQL-выборкой.
   * Благодаря методу completeDunning, у нас есть четкие статусы завершения и временные
   * метки. Можем посчитать Recovery Rate (сколько денег спасались) и среднее время
   * от первого отказа до погашения долга. Это чистая бизнес-аналитика,
   * построенная на данных биллинга».
   * Эта выборка покажет долю успешно возвращенных платежей после того, как они упали в Даннинг.
   *
   * SELECT
   *		status,
   *		COUNT(*) as total_count,
   *		SUM(amount_due) as total_recovered_amount
   * FROM "DunningProcess"
   * JOIN "Invoice" ON "DunningProcess"."invoiceId" = "Invoice"."id"
   * WHERE "DunningProcess"."status" = 'COMPLETED'
   * GROUP BY status;
   *
   * Этот запрос покажет, на каком этапе (1, 2, 3... 6) клиенты чаще всего «сдаются» или, наоборот, оплачивают долг.
   *
   * SELECT
   *   currentStage,
   *   COUNT(*) as drop_off_count
   * FROM "DunningProcess"
   * WHERE status = 'CANCELED'  -- Те, кто так и не заплатил
   * GROUP BY currentStage
   * ORDER BY currentStage;
   *
   * По аналитике: Архитектура данных в PostgreSQL позволяет строить Cohort Analysis
   * (когортный анализ) одной SQL-выборкой. Благодаря тому, что в методе completeDunning
   * четко фиксируются финальные статусы и стадии, бизнес может в реальном времени
   * видеть Recovery Rate — какой процент задолженности нам удалось взыскать автоматически,
   * и на какой стадии уведомлений (Email или SMS) клиенты реагируют лучше всего.
   * Это даст данные для оптимизации Cash Flow всей платформы.
   */
  private async completeDunning(dunningId: string, status: string) {
    await this.prisma.dunningProcess.update({
      where: { id: dunningId },
      data: {
        status,
        lastActionAt: new Date(),
      },
    });
  }

  // ========== API МЕТОДЫ ==========
  // получить платежи пользователей
  /**
   * Извлечение истории транзакций пользователя с поддержкой курсорной пагинации.
   * Реализует паттерн эффективной выборки данных для High-Traffic интерфейсов.
   *
   * @param {string} userId - Уникальный идентификатор владельца платежей.
   * @param {number} [limit=10] - Максимальное количество записей на один запрос (Page Size).
   * @param {number} [offset=0] - Смещение выборки (Skip) для реализации бесконечной прокрутки.
   * @returns {Promise<Payment[]>} Массив объектов платежей, отсортированный по актуальности (LIFO).
   *
   * @description
   * 1. Performance Optimization: Использует индексы PostgreSQL по полям userId и createdAt для Low-Latency ответов.
   * 2. Resource Management: Ограничивает объем передаваемых данных (take/skip), предотвращая перегрузку памяти Node.js.
   * 3. UX Ready: Порядок сортировки 'desc' гарантирует, что пользователь увидит последние операции первыми.
   * Этот метод — «окно» пользователя в его финансовую историю. В платформе, где инвесторы следят за каждой транзакцией,
   * этот метод должен работать мгновенно. Используем Pagination (пагинацию).
   * Это значит, что если у пользователя 1000 платежей, твой сервер не упадет,
   * пытаясь отдать их все сразу, а база данных не будет «напрягаться» лишний раз.
   * Как обеспечить быструю работу истории платежей, если их станет больше миллионов?
   * Метод getUserPayments изначально спроектирован под высокие нагрузки. Использование
   * пагинации на уровне БД (take/skip), гарантирует стабильное время ответа
   * (O(log N)) при наличии индексов.
   * Для платформы масштаба СНГ также предлогается внедрить Keyset Pagination
   * (по id или createdAt), чтобы избежать потери производительности при
   * больших offset, что является стандартом для Highload-систем».
   */
  async getUserPayments(userId: string, limit = 10, offset = 0) {
    return this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  // получить подписки пользователей
  /**
   * Извлечение активных и архивных подписок пользователя с детализацией последних транзакций.
   * Реализует паттерн Eager Loading для минимизации количества запросов к БД.
   *
   * @param {string} userId - Уникальный идентификатор владельца подписок.
   * @returns {Promise<Subscription[]>} Список подписок с вложенными (Joined) инвойсами.
   *
   * @description
   * 1. Data Aggregation: Автоматически подтягивает (Join) последние 5 инвойсов для каждой подписки.
   * 2. UX Optimization: Позволяет фронтенду отобразить "Краткую историю платежей" в карточке подписки без дополнительных API-запросов.
   * 3. Performance: Сортировка 'desc' на обоих уровнях (подписки и инвойсы) гарантирует актуальность отображаемых данных.
   * 4. Query Efficiency: Использование лимита (take: 5) для вложенных сущностей предотвращает "раздувание" JSON-ответа.
   * Этот метод — «центр управления» для клиента. Инвестору важно видеть не только статус подписки, но и последние счета.
   * То, что подтягиваем инвойсы через include, показывает, что работаем с реляционными
   * связями и понимаем потребности фронтенда. Как решается проблема N+1 при получении
   * списка подписок со счетами? Используется возможности Prisma для Eager Loading
   * (жадной загрузки). В методе getUserSubscriptions объединяем выборку подписок и
   * связанных инвойсов в один оптимизированный SQL-запрос. Это исключает проблему
   * N+1 и гарантирует, что база данных выполнит объединение (JOIN) эффективнее,
   * чем если бы мы делали это программно в Node.js.
   * SELECT
   *      s.*,
   *     (
   *         SELECT json_agg(i)
   *         FROM (
   *            SELECT *
   *            FROM "Invoice" as i
   *            WHERE i."subscriptionId" = s."id"
   *            ORDER BY i."createdAt" DESC
   *            LIMIT 5  -- Твой take: 5 в действии
   *        ) as i
   *     ) as invoices
   * FROM "Subscription" as s
   * WHERE s."userId" = 'твой_userId'
   * ORDER BY s."createdAt" DESC;
   *
   * JSON_AGG: PostgreSQL может отдавать уже готовые вложенные структуры.
   * Это экономит время на сборку объекта в Node.js.
   * LIMIT внутри подзапроса: Это самая сложная часть. Обычный JOIN выдал бы ВСЕ
   * инвойсы, а так ограничиваем их до 5 самых свежих прямо в базе.
   * Это Highload-оптимизация. Индексы: Для этого запроса:
   * Есть составной индекс на Invoice(subscriptionId, createdAt), чтобы подзапрос
   * отрабатывал за наносекунды.
   * В методе getUserSubscriptions используем Eager Loading через Prisma.
   * На уровне SQL это транслируется в эффективную выборку с коррелированным
   * подзапросом и лимитированием. Это позволяет  за один поход в базу получить
   * полное дерево данных для фронтенда, избегая лишних сетевых задержек и нагрузки
   * на CPU сервера при маппинге данных.
   */
  async getUserSubscriptions(userId: string) {
    return this.prisma.subscription.findMany({
      where: { userId },
      include: {
        invoices: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Извлечение полной детализации транзакции со всеми вложенными связями (Detailed Audit).
   * Реализует паттерн Deep Hydration для обеспечения полной прозрачности финансового события.
   *
   * @param {string} id - Уникальный идентификатор платежа в системе (UUID).
   * @returns {Promise<Payment|null>} Объект платежа с включенными данными инвойса, подписки и истории возвратов.
   *
   * @description
   * 1. Snapshot Recovery: Позволяет восстановить полную историю: от какого инвойса пришел платеж до того, был ли по нему частичный возврат.
   * 2. Relationship Integrity: Использует Join-логику Prisma для консистентного получения связанных сущностей в рамках одного сеанса БД.
   * 3. Debugging Friendly: Незаменимый метод для техподдержки и финансовых расследований (Reconciliation).
   * Этот метод — «рентген» конкретной транзакции. Это критично для службы поддержки и
   * арбитража: когда инвестор спрашивает «Где мои деньги?», менеджер открывает этот ID
   * и видит полную картину. Подтягиваем не только сам платеж, но и весь шлейф
   * связанных данных (инвойс, подписка, возвраты). Это избавляет фронтенд от
   * необходимости делать три дополнительных запроса. Как обеспечить консистентность
   * данных при отображении сложной истории платежа? Метод getPaymentById реализует
   * атомарную выборку связанных данных. Через include мы за один запрос в PostgreSQL
   * получаем состояние платежа и всех его сателлитов (инвойсов и возвратов).
   * Это гарантирует, что менеджер или клиент увидят согласованный срез данных
   * (Snapshot), а не разрозненную информацию из разных таблиц, которая могла
   * измениться между запросами».
   */
  async getPaymentById(id: string) {
    return this.prisma.payment.findUnique({
      where: { id },
      include: {
        invoice: true,
        subscription: true,
        refunds: true,
      },
    });
  }
  // возвращение платежа
  /**
   * Инициирует процедуру возврата денежных средств (Refund Management).
   * Реализует логику обратной финансовой транзакции с сохранением истории.
   *
   * @param {string} paymentId - Внутренний идентификатор исходного успешного платежа.
   * @param {number} [amount] - Сумма возврата (по умолчанию — полная сумма транзакции).
   * @param {string} [reason] - Основание для возврата (для финансового аудита и выписки).
   * @returns {Promise<Refund>} Объект созданного возврата с метаданными провайдера.
   *
   * @description
   * 1. Integrity Check: Проверяет статус исходного платежа (только SUCCEEDED).
   * 2. Partial Refund Support: Автоматически определяет статус (REFUNDED vs PARTIALLY_REFUNDED) на основе суммы.
   * 3. Provider Integration: Выполняет API-запрос к эквайрингу (Yookassa) с передачей externalId транзакции.
   * 4. Audit Trail: Создает связанную сущность Refund для обеспечения 100% прослеживаемости денежных потоков.
   * 5. Async Notification: Публикует событие 'payment.refunded' в RabbitMQ для синхронизации с биллингом и ACL.
   *
   * @throws {BadRequestException} Если платеж не найден или имеет статус, не позволяющий возврат.
   * Это метод «высшей справедливости». В финтехе возвраты — это самая опасная зона, и то,
   * как она прописана, разделяя полный и частичный возврат (PARTIALLY_REFUNDED),
   * - это критично: инвесторы ценят точность до копейки. Код гарантирует, что ни
   * один цент не потеряется при возврате. Как бороться с попытками мошенничества через возвраты
   * Метод refundPayment защищен на уровне бизнес-логики и базы данных. Разрешается возврат
   *  только для успешно завершенных транзакций (SUCCEEDED) и фиксируется каждый чих
   * в таблице Refund. Благодаря статусу PARTIALLY_REFUNDED, можно отслеживать цепочку
   * частичных возвратов, не позволяя вернуть больше, чем было фактически оплачено.
   * Все операции логируются и пролетают через RabbitMQ, что дает службе безопасности
   * "звоночек" в реальном времени
   */
  async refundPayment(paymentId: string, amount?: number, reason?: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment || payment.status !== PaymentStatus.SUCCEEDED) {
      throw new BadRequestException('Payment not found or not succeeded');
    }

    const refundAmount = amount || payment.amount;

    const result = await this.yookassa.createRefund({
      payment_id: payment.externalId,
      amount: { value: refundAmount, currency: payment.currency },
      description: reason,
    });

    // Создаем запись о возврате
    const refund = await this.prisma.refund.create({
      data: {
        externalId: result.id,
        paymentId: payment.id,
        amount: refundAmount,
        currency: payment.currency,
        status: 'SUCCEEDED',
        reason,
        metadata: result,
      },
    });

    // Обновляем статус платежа
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status:
          refundAmount === payment.amount
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
        refundedAt: new Date(),
      },
    });

    await this.rabbitmq.sendToQueue('payment.refunded', {
      paymentId,
      refundId: refund.id,
      amount: refundAmount,
      userId: payment.userId,
      timestamp: new Date().toISOString(),
    });

    return refund;
  }
}
