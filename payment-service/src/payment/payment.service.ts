import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
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

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly rabbitmq: RabbitMQService,
    private readonly yookassa: YookassaService,
  ) {}

  // ========== ОСНОВНЫЕ ПЛАТЕЖИ ==========

  async createPayment(createPaymentDto: any) {
    // Идемпотентность по paymentKey
    const idempotencyKey =
      createPaymentDto.idempotencyKey || `pay_${Date.now()}`;
    const cached = await this.redis.getIdempotencyResult(
      `payment:${idempotencyKey}`,
    );

    // Если ключ такой уже есть то вернем значение ключа
    if (cached) {
      this.logger.log(`Returning cached payment for key: ${idempotencyKey}`);
      return cached;
    }

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

      // Кэшируем результат
      await this.redis.setIdempotencyResult(
        `payment:${idempotencyKey}`,
        result,
        300,
      );

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
  }

  // Подтверждение платежа
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

    return { invoice, payment };
  }

  // повторяющаяся оплата
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

    return subscription;
  }

  // ========== ДАННИНГ ==========

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

    return dunningProcess;
  }

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

      return { completed: false, nextStage: dunning.currentStage + 1 };
    }

    await this.completeDunning(dunningId, 'COMPLETED');
    return { completed: true, reason: 'All stages completed' };
  }

  // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

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

  async getUserPayments(userId: string, limit = 10, offset = 0) {
    return this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

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
