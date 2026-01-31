/* eslint-disable @typescript-eslint/no-unsafe-argument */
// src/payment/providers/yookassa/yookassa.service.ts
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { catchError, timeout, retry, map } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma.service';
import { RedisService } from '../redis/redis.service';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service';
import {
  PaymentProvider,
  PaymentStatus,
  RefundStatus,
} from '../../payment/enums/payment.enum';
import {
  CreatePaymentDto,
  ConfirmPaymentDto,
  CreateRefundDto,
  WebhookEventDto,
} from '../../payment/dto/payment.dto';

interface YookassaConfig {
  shopId: string;
  secretKey: string;
  apiUrl: string;
  webhookUrl: string;
  timeout: number;
}

// Удалите AxiosInstance - используем HttpService из NestJS

@Injectable()
export class YookassaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(YookassaService.name);
  private config: YookassaConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService, // Используем HttpService вместо axios
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly rabbitmqService: RabbitMQService,
  ) {
    this.config = this.getConfig();
  }

  async onModuleInit() {
    await this.setupWebhook();
    await this.subscribeToPaymentEvents();
  }

  async onModuleDestroy() {
    // Cleanup если нужно
  }

  private getConfig(): YookassaConfig {
    return {
      shopId: this.configService.get<string>('YOOKASSA_SHOP_ID', ''),
      secretKey: this.configService.get<string>('YOOKASSA_SECRET_KEY', ''),
      apiUrl: this.configService.get<string>(
        'YOOKASSA_API_URL',
        'https://api.yookassa.ru/v3/',
      ),
      webhookUrl: this.configService.get<string>('YOOKASSA_WEBHOOK_URL', ''),
      timeout: this.configService.get<number>('YOOKASSA_TIMEOUT', 10000),
    };
  }

  private getHttpConfig(idempotenceKey: string) {
    return {
      baseURL: this.config.apiUrl,
      timeout: this.config.timeout,
      auth: {
        username: this.config.shopId,
        password: this.config.secretKey,
      },
      headers: {
        'Idempotence-Key': idempotenceKey,
        'Content-Type': 'application/json',
      },
    };
  }

  private async setupWebhook(): Promise<void> {
    try {
      const webhookId = await this.redisService.get('yookassa:webhook:id');

      if (!webhookId) {
        const idempotenceKey = uuidv4();

        // Используем firstValueFrom с HttpService
        const response = await firstValueFrom(
          this.httpService
            .post(
              '/webhooks',
              {
                event: 'payment.waiting_for_capture',
                url: this.config.webhookUrl,
              },
              this.getHttpConfig(idempotenceKey),
            )
            .pipe(
              map((res) => res.data),
              timeout(this.config.timeout),
              catchError(this.handleApiError.bind(this, 'setupWebhook')),
            ),
        );

        await this.redisService.set(
          'yookassa:webhook:id',
          response.id,
          'EX',
          30 * 24 * 60 * 60, // 30 дней
        );
      }
    } catch (error) {
      this.logger.error('Failed to setup webhook', error);
    }
  }

  private async subscribeToPaymentEvents(): Promise<void> {
    // Подписка на события RabbitMQ для обработки платежей
    await this.rabbitmqService.subscribe('payment.created', async (message) => {
      await this.handlePaymentCreated(message);
    });

    await this.rabbitmqService.subscribe(
      'payment.succeeded',
      async (message) => {
        await this.handlePaymentSucceeded(message);
      },
    );

    await this.rabbitmqService.subscribe(
      'payment.canceled',
      async (message) => {
        await this.handlePaymentCanceled(message);
      },
    );
  }

  async createPayment(createPaymentDto: CreatePaymentDto) {
    const idempotenceKey = uuidv4();
    const internalPaymentId = `pay_${uuidv4()}`;

    try {
      // Сохраняем в кэш для предотвращения дублирования
      const cacheKey = `payment:${idempotenceKey}`;
      const cached = await this.redisService.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      // Сохраняем платеж в БД
      const payment = await this.prisma.payment.create({
        data: {
          externalId: internalPaymentId,
          provider: PaymentProvider.YOOKASSA,
          amount: createPaymentDto.amount.value,
          currency: createPaymentDto.amount.currency,
          status: PaymentStatus.PENDING,
          userId: createPaymentDto.metadata.userId,
          orderId: createPaymentDto.metadata.orderId,
          description: createPaymentDto.description,
          metadata: createPaymentDto.metadata as any,
        },
      });

      // Подготавливаем запрос к Yookassa
      const yookassaRequest = {
        amount: {
          value: createPaymentDto.amount.value.toFixed(2),
          currency: createPaymentDto.amount.currency,
        },
        payment_method_data: {
          type: createPaymentDto.payment_method_data.type,
        },
        confirmation: {
          type: createPaymentDto.confirmation.type,
          return_url: createPaymentDto.confirmation.return_url,
        },
        capture: createPaymentDto.capture ?? true,
        description: createPaymentDto.description,
        metadata: {
          ...createPaymentDto.metadata,
          internalPaymentId: payment.id,
        },
      };

      // Добавляем чек для российского законодательства
      if (createPaymentDto.receipt) {
        yookassaRequest.receipt = createPaymentDto.receipt;
      }

      // Отправляем запрос в Yookassa с использованием firstValueFrom
      const yookassaPayment = await firstValueFrom(
        this.httpService
          .post(
            '/payments',
            yookassaRequest,
            this.getHttpConfig(idempotenceKey),
          )
          .pipe(
            map((response) => response.data),
            timeout(this.config.timeout),
            retry({
              count: 3,
              delay: 1000,
            }),
            catchError(this.handleApiError.bind(this, 'createPayment')),
          ),
      );

      // Обновляем платеж в БД с externalId от Yookassa
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          externalId: yookassaPayment.id,
          providerData: yookassaPayment as any,
        },
      });

      // Кэшируем результат
      await this.redisService.set(
        cacheKey,
        JSON.stringify(yookassaPayment),
        'EX',
        300, // 5 минут
      );

      // Публикуем событие о создании платежа
      await this.rabbitmqService.publish('payment.created', {
        paymentId: payment.id,
        yookassaPaymentId: yookassaPayment.id,
        amount: createPaymentDto.amount.value,
        userId: createPaymentDto.metadata.userId,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(
        `Payment created: ${yookassaPayment.id} for order ${createPaymentDto.metadata.orderId}`,
      );

      return {
        id: yookassaPayment.id,
        status: yookassaPayment.status,
        confirmation: yookassaPayment.confirmation,
        paid: yookassaPayment.paid,
        amount: yookassaPayment.amount,
        description: yookassaPayment.description,
        metadata: yookassaPayment.metadata,
      };
    } catch (error) {
      this.logger.error('Failed to create Yookassa payment', error);

      // Публикуем событие об ошибке
      await this.rabbitmqService.publish('payment.failed', {
        internalPaymentId,
        error: error.message,
        timestamp: new Date().toISOString(),
      });

      throw error; // Ошибка уже обработана в catchError
    }
  }

  async confirmPayment(confirmPaymentDto: ConfirmPaymentDto) {
    try {
      // Проверяем в Redis, не обрабатывался ли уже платеж
      const cacheKey = `payment:capture:${confirmPaymentDto.paymentId}`;
      const cached = await this.redisService.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      const idempotenceKey = uuidv4();

      // Подтверждаем платеж в Yookassa с firstValueFrom
      const yookassaPayment = await firstValueFrom(
        this.httpService
          .post(
            `/payments/${confirmPaymentDto.paymentId}/capture`,
            {},
            this.getHttpConfig(idempotenceKey),
          )
          .pipe(
            map((response) => response.data),
            timeout(this.config.timeout),
            retry(2),
            catchError(this.handleApiError.bind(this, 'confirmPayment')),
          ),
      );

      // Обновляем статус в БД
      const payment = await this.prisma.payment.update({
        where: { externalId: confirmPaymentDto.paymentId },
        data: {
          status: PaymentStatus.SUCCEEDED,
          capturedAt: new Date(),
          providerData: yookassaPayment as any,
        },
      });

      // Кэшируем результат
      await this.redisService.set(
        cacheKey,
        JSON.stringify(yookassaPayment),
        'EX',
        300, // 5 минут
      );

      // Публикуем событие об успешном платеже
      await this.rabbitmqService.publish('payment.succeeded', {
        paymentId: payment.id,
        yookassaPaymentId: yookassaPayment.id,
        amount: yookassaPayment.amount.value,
        userId: payment.userId,
        orderId: payment.orderId,
        timestamp: new Date().toISOString(),
      });

      // Обновляем заказ (пример)
      await this.updateOrderStatus(payment.orderId, 'PAID');

      this.logger.log(`Payment confirmed: ${confirmPaymentDto.paymentId}`);

      return {
        id: yookassaPayment.id,
        status: yookassaPayment.status,
        paid: yookassaPayment.paid,
        captured: true,
      };
    } catch (error) {
      this.logger.error('Failed to confirm Yookassa payment', error);
      throw error;
    }
  }

  async createRefund(createRefundDto: CreateRefundDto) {
    const idempotenceKey = uuidv4();

    try {
      // Создаем возврат в Yookassa с firstValueFrom
      const refund = await firstValueFrom(
        this.httpService
          .post(
            '/refunds',
            {
              payment_id: createRefundDto.payment_id,
              amount: {
                value: createRefundDto.amount.value.toFixed(2),
                currency: createRefundDto.amount.currency,
              },
              description: createRefundDto.description,
            },
            this.getHttpConfig(idempotenceKey),
          )
          .pipe(
            map((response) => response.data),
            timeout(this.config.timeout),
            catchError(this.handleApiError.bind(this, 'createRefund')),
          ),
      );

      // Сохраняем возврат в БД
      await this.prisma.refund.create({
        data: {
          externalId: refund.id,
          paymentId: createRefundDto.payment_id,
          amount: createRefundDto.amount.value,
          currency: createRefundDto.amount.currency,
          status: RefundStatus.SUCCEEDED,
          reason: createRefundDto.description,
          metadata: refund as any,
        },
      });

      // Обновляем статус платежа
      await this.prisma.payment.update({
        where: { externalId: createRefundDto.payment_id },
        data: { status: PaymentStatus.REFUNDED },
      });

      // Публикуем событие о возврате
      await this.rabbitmqService.publish('payment.refunded', {
        paymentId: createRefundDto.payment_id,
        refundId: refund.id,
        amount: createRefundDto.amount.value,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(
        `Refund created: ${refund.id} for payment ${createRefundDto.payment_id}`,
      );

      return {
        id: refund.id,
        status: refund.status,
        payment_id: refund.payment_id,
        amount: refund.amount,
      };
    } catch (error) {
      this.logger.error('Failed to create refund', error);
      throw error;
    }
  }

  async getPaymentStatus(paymentId: string) {
    const cacheKey = `payment:status:${paymentId}`;

    try {
      // Пробуем получить из кэша
      const cached = await this.redisService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const idempotenceKey = uuidv4();

      // Получаем из Yookassa с firstValueFrom
      const payment = await firstValueFrom(
        this.httpService
          .get(`/payments/${paymentId}`, this.getHttpConfig(idempotenceKey))
          .pipe(
            map((response) => response.data),
            timeout(5000), // Быстрый таймаут для статуса
            catchError(this.handleApiError.bind(this, 'getPaymentStatus')),
          ),
      );

      // Кэшируем статус на 1 минуту
      await this.redisService.set(cacheKey, JSON.stringify(payment), 'EX', 60);

      return payment;
    } catch (error) {
      this.logger.error(`Failed to get payment status: ${paymentId}`, error);

      // Пробуем получить из БД
      const dbPayment = await this.prisma.payment.findFirst({
        where: { externalId: paymentId },
      });

      return dbPayment
        ? {
            id: dbPayment.externalId,
            status: dbPayment.status,
            amount: { value: dbPayment.amount, currency: dbPayment.currency },
          }
        : null;
    }
  }

  // Общий обработчик ошибок для API Yookassa
  private handleApiError(operation: string, error: any) {
    this.logger.error(`Yookassa API error in ${operation}:`, {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });

    if (error.code === 'ECONNABORTED' || error.name === 'TimeoutError') {
      throw new ServiceUnavailableException('Payment gateway timeout');
    }

    if (error.response?.status === 404) {
      throw new NotFoundException('Payment not found');
    }

    if (error.response?.status === 402) {
      throw new Error('Payment declined by provider');
    }

    if (error.response?.status === 429) {
      throw new ServiceUnavailableException(
        'Too many requests to payment gateway',
      );
    }

    throw new Error(`Payment service error: ${error.message}`);
  }

  async handleWebhook(event: WebhookEventDto): Promise<void> {
    // Валидация подписи webhook (опущена для краткости)

    try {
      const { type, object } = event;

      // Сохраняем webhook event в БД для аудита
      await this.prisma.webhookEvent.create({
        data: {
          provider: PaymentProvider.YOOKASSA,
          eventType: type,
          data: object as any,
          processed: false,
        },
      });

      // Обрабатываем разные типы событий
      switch (type) {
        case 'payment.succeeded':
          await this.handlePaymentWebhook(object);
          break;
        case 'payment.waiting_for_capture':
          await this.handlePaymentWaitingForCapture(object);
          break;
        case 'payment.canceled':
          await this.handlePaymentCanceledWebhook(object);
          break;
        case 'refund.succeeded':
          await this.handleRefundWebhook(object);
          break;
        default:
          this.logger.warn(`Unhandled webhook event type: ${type}`);
      }

      // Публикуем событие в RabbitMQ
      await this.rabbitmqService.publish('yookassa.webhook', {
        type,
        paymentId: object.id,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Failed to handle webhook', error);
      throw error;
    }
  }

  private async handlePaymentWebhook(payment: any): Promise<void> {
    // Обновляем платеж в БД
    await this.prisma.payment.update({
      where: { externalId: payment.id },
      data: {
        status: PaymentStatus.SUCCEEDED,
        providerData: payment as any,
        capturedAt: new Date(),
      },
    });

    // Инвалидируем кэш
    await this.redisService.del(`payment:status:${payment.id}`);
  }

  private async handlePaymentWaitingForCapture(payment: any): Promise<void> {
    // Автоподтверждение платежа, если настроено
    const autoCapture = this.configService.get<boolean>(
      'YOOKASSA_AUTO_CAPTURE',
      true,
    );

    if (autoCapture) {
      await this.confirmPayment({
        paymentId: payment.id,
      });
    }
  }

  private async handlePaymentCanceledWebhook(payment: any): Promise<void> {
    await this.prisma.payment.update({
      where: { externalId: payment.id },
      data: {
        status: PaymentStatus.CANCELED,
        providerData: payment as any,
      },
    });

    await this.rabbitmqService.publish('payment.canceled', {
      paymentId: payment.id,
      reason: payment.cancellation_details?.reason,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleRefundWebhook(refund: any): Promise<void> {
    // Обновляем статус возврата
    await this.prisma.refund.update({
      where: { externalId: refund.id },
      data: {
        status: RefundStatus.SUCCEEDED,
        metadata: refund as any,
      },
    });
  }

  private async handlePaymentCreated(message: any): Promise<void> {
    // Обработка события создания платежа
    this.logger.log(`Processing payment created event: ${message.paymentId}`);
  }

  private async handlePaymentSucceeded(message: any): Promise<void> {
    // Обработка успешного платежа
    this.logger.log(`Processing payment succeeded event: ${message.paymentId}`);
  }

  private async handlePaymentCanceled(message: any): Promise<void> {
    // Обработка отмененного платежа
    this.logger.log(`Processing payment canceled event: ${message.paymentId}`);
  }

  private async updateOrderStatus(
    orderId: string,
    status: string,
  ): Promise<void> {
    // Обновление статуса заказа
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status },
    });
  }
}
