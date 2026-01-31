// payment.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../providers/redis/redis.service';
import { RabbitMQService } from '../providers/rabbitmq/rabbitmq.service';
import { YookassaService } from '../providers/yookassa/yookassa.service';
import { PaymentService } from './payment.service';
import {
  PaymentStatus,
  SubscriptionStatus,
  InvoiceStatus,
  PaymentProvider,
} from './enums/payment.enum';

// Моки для зависимостей
const mockPrismaService = {
  payment: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  subscription: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  invoice: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
  },
  paymentMethod: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
  dunningProcess: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  refund: {
    create: jest.fn(),
  },
};

const mockRedisService = {
  getIdempotencyResult: jest.fn(),
  setIdempotencyResult: jest.fn(),
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
};

const mockRabbitMQService = {
  sendToQueue: jest.fn(),
};

const mockYookassaService = {
  createPayment: jest.fn(),
  confirmPayment: jest.fn(),
  createRefund: jest.fn(),
};

// Отключаем логгер в тестах
jest.mock('@nestjs/common', () => ({
  ...jest.requireActual('@nestjs/common'),
  Logger: jest.fn().mockImplementation(() => ({
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  })),
}));

describe('PaymentService', () => {
  let service: PaymentService;
  let prisma: PrismaService;
  let redis: RedisService;
  let rabbitmq: RabbitMQService;
  let yookassa: YookassaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RedisService, useValue: mockRedisService },
        { provide: RabbitMQService, useValue: mockRabbitMQService },
        { provide: YookassaService, useValue: mockYookassaService },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
    prisma = module.get<PrismaService>(PrismaService);
    redis = module.get<RedisService>(RedisService);
    rabbitmq = module.get<RabbitMQService>(RabbitMQService);
    yookassa = module.get<YookassaService>(YookassaService);

    // Сброс всех моков перед каждым тестом
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ========== CREATE PAYMENT TESTS ==========
  describe('createPayment', () => {
    const createPaymentDto = {
      amount: 1000,
      currency: 'RUB',
      userId: 'user-123',
      orderId: 'order-456',
      description: 'Test payment',
      provider: PaymentProvider.YOOKASSA,
    };

    it('should return cached payment if idempotency key exists', async () => {
      // Arrange
      const cachedResult = { id: 'cached-123', status: 'PENDING' };
      const dtoWithKey = { ...createPaymentDto, idempotencyKey: 'test-key' };

      mockRedisService.getIdempotencyResult.mockResolvedValue(cachedResult);

      // Act
      const result = await service.createPayment(dtoWithKey);

      // Assert
      expect(redis.getIdempotencyResult).toHaveBeenCalledWith(
        'payment:test-key',
      );
      expect(result).toEqual(cachedResult);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictException if duplicate order exists', async () => {
      // Arrange
      const existingPayment = { id: 'existing-123', status: 'PENDING' };
      mockRedisService.getIdempotencyResult.mockResolvedValue(null);
      mockPrismaService.payment.findFirst.mockResolvedValue(existingPayment);

      // Act & Assert
      await expect(service.createPayment(createPaymentDto)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.payment.findFirst).toHaveBeenCalledWith({
        where: {
          orderId: 'order-456',
          status: { in: ['PENDING', 'SUCCEEDED'] },
        },
      });
    });

    it('should create payment successfully', async () => {
      // Arrange
      const createdPayment = {
        id: 'payment-123',
        amount: 1000,
        currency: 'RUB',
        status: PaymentStatus.PENDING,
        userId: 'user-123',
        orderId: 'order-456',
        provider: PaymentProvider.YOOKASSA,
      };

      const yookassaResult = {
        id: 'ext-123',
        confirmation: { confirmation_url: 'https://payment.url' },
      };

      mockRedisService.getIdempotencyResult.mockResolvedValue(null);
      mockPrismaService.payment.findFirst.mockResolvedValue(null);
      mockPrismaService.payment.create.mockResolvedValue(createdPayment);
      mockYookassaService.createPayment.mockResolvedValue(yookassaResult);
      mockPrismaService.payment.update.mockResolvedValue({
        ...createdPayment,
        externalId: 'ext-123',
      });
      mockRedisService.setIdempotencyResult.mockResolvedValue(true);

      // Act
      const result = await service.createPayment(createPaymentDto);

      // Assert
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          amount: 1000,
          currency: 'RUB',
          status: PaymentStatus.PENDING,
          userId: 'user-123',
          orderId: 'order-456',
          description: 'Test payment',
          metadata: {},
          provider: PaymentProvider.YOOKASSA,
          isRecurring: false,
        },
      });

      expect(yookassa.createPayment).toHaveBeenCalledWith({
        ...createPaymentDto,
        metadata: {
          internalPaymentId: 'payment-123',
          userId: 'user-123',
          orderId: 'order-456',
        },
      });

      expect(rabbitmq.sendToQueue).toHaveBeenCalledWith(
        'payment.created',
        expect.objectContaining({
          paymentId: 'payment-123',
          externalId: 'ext-123',
          userId: 'user-123',
          amount: 1000,
        }),
      );

      expect(result).toEqual({
        id: 'payment-123',
        externalId: 'ext-123',
        status: PaymentStatus.PENDING,
        confirmationUrl: 'https://payment.url',
        ...yookassaResult,
      });
    });

    it('should handle payment creation error', async () => {
      // Arrange
      const createdPayment = { id: 'payment-123' };
      const error = new Error('Yookassa API error');

      mockRedisService.getIdempotencyResult.mockResolvedValue(null);
      mockPrismaService.payment.findFirst.mockResolvedValue(null);
      mockPrismaService.payment.create.mockResolvedValue(createdPayment);
      mockYookassaService.createPayment.mockRejectedValue(error);

      // Act & Assert
      await expect(service.createPayment(createPaymentDto)).rejects.toThrow(
        'Yookassa API error',
      );

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-123' },
        data: {
          status: PaymentStatus.FAILED,
          errorMessage: 'Yookassa API error',
        },
      });

      expect(rabbitmq.sendToQueue).toHaveBeenCalledWith(
        'payment.failed',
        expect.objectContaining({
          paymentId: 'payment-123',
          userId: 'user-123',
          error: 'Yookassa API error',
        }),
      );
    });

    it('should throw BadRequestException for unsupported provider', async () => {
      // Arrange
      const dtoWithUnsupportedProvider = {
        ...createPaymentDto,
        provider: 'UNSUPPORTED_PROVIDER',
      };

      mockRedisService.getIdempotencyResult.mockResolvedValue(null);
      mockPrismaService.payment.findFirst.mockResolvedValue(null);
      mockPrismaService.payment.create.mockResolvedValue({
        id: 'payment-123',
        provider: 'UNSUPPORTED_PROVIDER',
      });

      // Act & Assert
      await expect(
        service.createPayment(dtoWithUnsupportedProvider),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========== CONFIRM PAYMENT TESTS ==========
  describe('confirmPayment', () => {
    const paymentId = 'ext-123';
    const confirmDto = {};

    it('should throw NotFoundException if payment not found', async () => {
      // Arrange
      mockPrismaService.payment.findUnique.mockResolvedValue(null);

      // Act & Assert
      await expect(
        service.confirmPayment(paymentId, confirmDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should confirm payment successfully', async () => {
      // Arrange
      const payment = {
        id: 'db-123',
        externalId: 'ext-123',
        userId: 'user-123',
        isRecurring: false,
        subscriptionId: null,
      };

      const yookassaResult = { id: 'ext-123', status: 'succeeded' };

      mockPrismaService.payment.findUnique.mockResolvedValue(payment);
      mockYookassaService.confirmPayment.mockResolvedValue(yookassaResult);
      mockPrismaService.payment.update.mockResolvedValue({
        ...payment,
        status: PaymentStatus.SUCCEEDED,
      });

      // Act
      const result = await service.confirmPayment(paymentId, confirmDto);

      // Assert
      expect(yookassa.confirmPayment).toHaveBeenCalledWith({
        paymentId: 'ext-123',
        ...confirmDto,
      });

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'db-123' },
        data: {
          status: PaymentStatus.SUCCEEDED,
          capturedAt: expect.any(Date),
          providerData: yookassaResult,
        },
      });

      expect(rabbitmq.sendToQueue).toHaveBeenCalledWith(
        'payment.succeeded',
        expect.objectContaining({
          paymentId: 'db-123',
          externalId: 'ext-123',
          userId: 'user-123',
        }),
      );

      expect(result).toEqual(yookassaResult);
    });

    it('should save payment method if recurring', async () => {
      // Arrange
      const payment = {
        id: 'db-123',
        externalId: 'ext-123',
        userId: 'user-123',
        isRecurring: true,
        subscriptionId: null,
      };

      const yookassaResult = {
        id: 'ext-123',
        status: 'succeeded',
        payment_method: {
          id: 'pm-123',
          card: {
            last4: '4242',
            card_type: 'visa',
            expiry_month: 12,
            expiry_year: 2025,
          },
        },
      };

      mockPrismaService.payment.findUnique.mockResolvedValue(payment);
      mockYookassaService.confirmPayment.mockResolvedValue(yookassaResult);
      mockPrismaService.paymentMethod.findFirst.mockResolvedValue(null);

      // Act
      await service.confirmPayment(paymentId, confirmDto);

      // Assert
      expect(prisma.paymentMethod.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-123',
          provider: PaymentProvider.YOOKASSA,
          type: 'CARD',
          externalId: 'pm-123',
          last4: '4242',
          brand: 'visa',
          expiryMonth: 12,
          expiryYear: 2025,
          isDefault: true,
          metadata: yookassaResult.payment_method,
        },
      });
    });

    it('should activate subscription if exists', async () => {
      // Arrange
      const payment = {
        id: 'db-123',
        externalId: 'ext-123',
        userId: 'user-123',
        isRecurring: false,
        subscriptionId: 'sub-123',
      };

      mockPrismaService.payment.findUnique.mockResolvedValue(payment);
      mockYookassaService.confirmPayment.mockResolvedValue({});
      mockPrismaService.subscription.update = jest.fn();

      // Мокаем приватный метод (не рекомендуется, но иногда нужно)
      // Лучше вынести activateSubscription в отдельный публичный/приватный метод
      jest
        .spyOn(service as any, 'activateSubscription')
        .mockResolvedValue(undefined);

      // Act
      await service.confirmPayment(paymentId, confirmDto);

      // Assert
      expect((service as any).activateSubscription).toHaveBeenCalledWith(
        'sub-123',
      );
    });
  });

  // ========== SUBSCRIPTION TESTS ==========
  describe('createSubscription', () => {
    const createSubscriptionDto = {
      userId: 'user-123',
      planId: 'plan-premium',
      planName: 'Premium Plan',
      price: 999,
      billingCycle: 'MONTHLY',
      trialDays: 7,
    };

    it('should throw ConflictException if active subscription exists', async () => {
      // Arrange
      const activeSubscription = {
        id: 'sub-123',
        status: SubscriptionStatus.ACTIVE,
      };

      mockPrismaService.subscription.findFirst.mockResolvedValue(
        activeSubscription,
      );

      // Act & Assert
      await expect(
        service.createSubscription(createSubscriptionDto),
      ).rejects.toThrow(ConflictException);
    });

    it('should create subscription with trial', async () => {
      // Arrange
      mockPrismaService.subscription.findFirst.mockResolvedValue(null);

      const createdSubscription = {
        id: 'sub-123',
        ...createSubscriptionDto,
        status: SubscriptionStatus.TRIALING,
        trialStart: expect.any(Date),
        trialEnd: expect.any(Date),
      };

      mockPrismaService.subscription.create.mockResolvedValue(
        createdSubscription,
      );

      // Act
      const result = await service.createSubscription(createSubscriptionDto);

      // Assert
      expect(prisma.subscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-123',
          planId: 'plan-premium',
          planName: 'Premium Plan',
          price: 999,
          billingCycle: 'MONTHLY',
          status: SubscriptionStatus.TRIALING,
          trialStart: expect.any(Date),
          trialEnd: expect.any(Date),
          currentPeriodStart: null,
          currentPeriodEnd: null,
        }),
      });

      expect(rabbitmq.sendToQueue).toHaveBeenCalledWith(
        'subscription.created',
        expect.objectContaining({
          subscriptionId: 'sub-123',
          userId: 'user-123',
          planId: 'plan-premium',
          status: SubscriptionStatus.TRIALING,
        }),
      );
    });

    it('should create invoice if no trial', async () => {
      // Arrange
      const dtoWithoutTrial = { ...createSubscriptionDto, trialDays: 0 };
      const createdSubscription = {
        id: 'sub-123',
        ...dtoWithoutTrial,
        status: SubscriptionStatus.PENDING,
      };

      mockPrismaService.subscription.findFirst.mockResolvedValue(null);
      mockPrismaService.subscription.create.mockResolvedValue(
        createdSubscription,
      );

      // Мокаем метод создания инвойса
      jest
        .spyOn(service as any, 'createInvoiceForSubscription')
        .mockResolvedValue({
          invoice: { id: 'inv-123' },
          payment: { id: 'pay-123' },
        });

      // Act
      await service.createSubscription(dtoWithoutTrial);

      // Assert
      expect(
        (service as any).createInvoiceForSubscription,
      ).toHaveBeenCalledWith('sub-123');
    });
  });

  // ========== PROCESS RECURRING PAYMENT TESTS ==========
  describe('processRecurringPayment', () => {
    const subscriptionId = 'sub-123';

    it('should throw ConflictException if lock already acquired', async () => {
      // Arrange
      mockRedisService.acquireLock.mockResolvedValue(false);

      // Act & Assert
      await expect(
        service.processRecurringPayment(subscriptionId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException if subscription not active', async () => {
      // Arrange
      mockRedisService.acquireLock.mockResolvedValue(true);
      mockPrismaService.subscription.findUnique.mockResolvedValue({
        status: SubscriptionStatus.CANCELED,
      });

      // Act & Assert
      await expect(
        service.processRecurringPayment(subscriptionId),
      ).rejects.toThrow(BadRequestException);

      expect(redis.releaseLock).toHaveBeenCalledWith(
        `lock:subscription:${subscriptionId}`,
      );
    });

    it('should process payment successfully with saved method', async () => {
      // Arrange
      const subscription = {
        id: 'sub-123',
        status: SubscriptionStatus.ACTIVE,
        userId: 'user-123',
        planName: 'Premium',
        price: 999,
        currency: 'RUB',
        defaultPaymentMethodId: 'pm-123',
        defaultPaymentMethod: {
          externalId: 'pm-ext-123',
        },
      };

      const invoice = { id: 'inv-123', amountDue: 999 };
      const payment = { id: 'pay-123', amount: 999 };
      const chargeResult = { id: 'charge-123' };

      mockRedisService.acquireLock.mockResolvedValue(true);
      mockPrismaService.subscription.findUnique.mockResolvedValue(subscription);

      jest
        .spyOn(service as any, 'createInvoiceForSubscription')
        .mockResolvedValue({ invoice, payment });

      jest
        .spyOn(service as any, 'chargePaymentMethod')
        .mockResolvedValue(chargeResult);

      // Act
      const result = await service.processRecurringPayment(subscriptionId);

      // Assert
      expect(result.success).toBe(true);
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-123' },
        data: {
          status: PaymentStatus.SUCCEEDED,
          externalId: 'charge-123',
          capturedAt: expect.any(Date),
        },
      });

      expect(prisma.invoice.update).toHaveBeenCalledWith({
        where: { id: 'inv-123' },
        data: {
          status: InvoiceStatus.PAID,
          paidAt: expect.any(Date),
          amountPaid: 999,
        },
      });

      expect((service as any).updateSubscriptionPeriod).toHaveBeenCalledWith(
        'sub-123',
      );

      expect(rabbitmq.sendToQueue).toHaveBeenCalledWith(
        'payment.recurring_succeeded',
        expect.any(Object),
      );
    });
  });

  // ========== DUNNING PROCESS TESTS ==========
  describe('startDunningProcess', () => {
    const invoiceId = 'inv-123';

    it('should throw BadRequestException if invoice not open', async () => {
      // Arrange
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        status: InvoiceStatus.PAID,
      });

      // Act & Assert
      await expect(service.startDunningProcess(invoiceId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should create dunning process successfully', async () => {
      // Arrange
      const invoice = {
        id: 'inv-123',
        userId: 'user-123',
        subscriptionId: 'sub-123',
        amountDue: 999,
        dueDate: new Date(),
        status: InvoiceStatus.OPEN,
        attemptCount: 0,
      };

      const dunningProcess = {
        id: 'dun-123',
        currentStage: 1,
        status: 'ACTIVE',
      };

      mockPrismaService.invoice.findUnique.mockResolvedValue(invoice);
      mockPrismaService.invoice.update.mockResolvedValue(invoice);
      mockPrismaService.dunningProcess.create.mockResolvedValue(dunningProcess);

      // Act
      const result = await service.startDunningProcess(invoiceId);

      // Assert
      expect(prisma.dunningProcess.create).toHaveBeenCalledWith({
        data: {
          invoiceId: 'inv-123',
          userId: 'user-123',
          subscriptionId: 'sub-123',
          currentStage: 1,
          maxStages: 6,
          nextActionAt: expect.any(Date),
          status: 'ACTIVE',
          metadata: {
            amountDue: 999,
            dueDate: invoice.dueDate,
          },
        },
      });

      expect(prisma.invoice.update).toHaveBeenCalledWith({
        where: { id: 'inv-123' },
        data: {
          attemptCount: { increment: 1 },
          nextAttemptAt: expect.any(Date),
        },
      });

      expect(rabbitmq.sendToQueue).toHaveBeenCalledWith(
        'dunning.started',
        expect.any(Object),
      );
    });
  });

  // ========== CANCEL SUBSCRIPTION TESTS ==========
  describe('cancelSubscription', () => {
    const subscriptionId = 'sub-123';

    it('should throw NotFoundException if subscription not found', async () => {
      // Arrange
      mockPrismaService.subscription.findUnique.mockResolvedValue(null);

      // Act & Assert
      await expect(service.cancelSubscription(subscriptionId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should cancel subscription immediately', async () => {
      // Arrange
      const subscription = {
        id: 'sub-123',
        userId: 'user-123',
      };

      mockPrismaService.subscription.findUnique.mockResolvedValue(subscription);
      mockPrismaService.subscription.update.mockResolvedValue({
        ...subscription,
        status: SubscriptionStatus.CANCELED,
        canceledAt: new Date(),
      });

      // Act
      const result = await service.cancelSubscription(subscriptionId, false);

      // Assert
      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-123' },
        data: {
          status: SubscriptionStatus.CANCELED,
          canceledAt: expect.any(Date),
        },
      });

      expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
        where: {
          subscriptionId: 'sub-123',
          status: InvoiceStatus.OPEN,
        },
        data: {
          status: InvoiceStatus.VOID,
        },
      });

      expect(rabbitmq.sendToQueue).toHaveBeenCalledWith(
        'subscription.canceled',
        expect.any(Object),
      );
    });
  });

  // ========== UTILITY METHODS TESTS ==========
  describe('utility methods', () => {
    describe('calculateNextBillingDate', () => {
      it('should calculate next billing date for MONTHLY', () => {
        // Arrange
        const fromDate = new Date('2024-01-15');
        const expectedDate = new Date('2024-02-15');

        // Act
        const result = (service as any).calculateNextBillingDate(
          'MONTHLY',
          fromDate,
        );

        // Assert
        expect(result).toEqual(expectedDate);
      });

      it('should calculate next billing date for YEARLY', () => {
        // Arrange
        const fromDate = new Date('2024-01-15');
        const expectedDate = new Date('2025-01-15');

        // Act
        const result = (service as any).calculateNextBillingDate(
          'YEARLY',
          fromDate,
        );

        // Assert
        expect(result).toEqual(expectedDate);
      });

      it('should default to MONTHLY for unknown cycle', () => {
        // Arrange
        const fromDate = new Date('2024-01-15');
        const expectedDate = new Date('2024-02-15');

        // Act
        const result = (service as any).calculateNextBillingDate(
          'UNKNOWN' as any,
          fromDate,
        );

        // Assert
        expect(result).toEqual(expectedDate);
      });
    });
  });

  // ========== GET METHODS TESTS ==========
  describe('getUserPayments', () => {
    it('should return user payments with pagination', async () => {
      // Arrange
      const userId = 'user-123';
      const payments = [
        { id: 'pay-1', amount: 1000 },
        { id: 'pay-2', amount: 2000 },
      ];

      mockPrismaService.payment.findMany.mockResolvedValue(payments);

      // Act
      const result = await service.getUserPayments(userId, 10, 0);

      // Assert
      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        skip: 0,
      });
      expect(result).toEqual(payments);
    });
  });

  describe('getPaymentById', () => {
    it('should return payment with relations', async () => {
      // Arrange
      const paymentId = 'pay-123';
      const paymentWithRelations = {
        id: 'pay-123',
        amount: 1000,
        invoice: { id: 'inv-123' },
        subscription: { id: 'sub-123' },
        refunds: [],
      };

      mockPrismaService.payment.findUnique.mockResolvedValue(
        paymentWithRelations,
      );

      // Act
      const result = await service.getPaymentById(paymentId);

      // Assert
      expect(prisma.payment.findUnique).toHaveBeenCalledWith({
        where: { id: 'pay-123' },
        include: {
          invoice: true,
          subscription: true,
          refunds: true,
        },
      });
      expect(result).toEqual(paymentWithRelations);
    });
  });

  // ========== REFUND TESTS ==========
  describe('refundPayment', () => {
    const paymentId = 'pay-123';
    const refundDto = { amount: 500, reason: 'Customer request' };

    it('should throw BadRequestException if payment not succeeded', async () => {
      // Arrange
      mockPrismaService.payment.findUnique.mockResolvedValue({
        status: PaymentStatus.PENDING,
      });

      // Act & Assert
      await expect(service.refundPayment(paymentId, 500)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should create partial refund successfully', async () => {
      // Arrange
      const payment = {
        id: 'pay-123',
        externalId: 'ext-123',
        amount: 1000,
        currency: 'RUB',
        status: PaymentStatus.SUCCEEDED,
        userId: 'user-123',
      };

      const refundResult = { id: 'ref-ext-123' };
      const createdRefund = { id: 'ref-123', amount: 500 };

      mockPrismaService.payment.findUnique.mockResolvedValue(payment);
      mockYookassaService.createRefund.mockResolvedValue(refundResult);
      mockPrismaService.refund.create.mockResolvedValue(createdRefund);
      mockPrismaService.payment.update.mockResolvedValue({
        ...payment,
        status: PaymentStatus.PARTIALLY_REFUNDED,
      });

      // Act
      const result = await service.refundPayment(
        paymentId,
        refundDto.amount,
        refundDto.reason,
      );

      // Assert
      expect(yookassa.createRefund).toHaveBeenCalledWith({
        payment_id: 'ext-123',
        amount: { value: 500, currency: 'RUB' },
        description: 'Customer request',
      });

      expect(prisma.refund.create).toHaveBeenCalledWith({
        data: {
          externalId: 'ref-ext-123',
          paymentId: 'pay-123',
          amount: 500,
          currency: 'RUB',
          status: 'SUCCEEDED',
          reason: 'Customer request',
          metadata: refundResult,
        },
      });

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-123' },
        data: {
          status: PaymentStatus.PARTIALLY_REFUNDED,
          refundedAt: expect.any(Date),
        },
      });

      expect(result).toEqual(createdRefund);
    });
  });
});
