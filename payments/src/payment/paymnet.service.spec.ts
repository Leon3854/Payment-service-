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
  subscribe: jest.fn(), // Добавлен метод subscribe
};

const mockYookassaService = {
  createPayment: jest.fn(),
  confirmPayment: jest.fn(),
  createRefund: jest.fn(),
};

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
      const dtoWithKey = {
        ...createPaymentDto,
        idempotencyKey: 'test-key', // Явный ключ
      };

      mockRedisService.getIdempotencyResult.mockResolvedValue(cachedResult);
      mockRedisService.acquireLock.mockResolvedValue(true);
      mockRedisService.releaseLock.mockResolvedValue(true);

      // Act
      const result = await service.createPayment(dtoWithKey);

      // Assert
      expect(redis.getIdempotencyResult).toHaveBeenCalledWith(
        'payment:test-key', // Ключ кэша
      );
      expect(result).toEqual(cachedResult);
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(redis.releaseLock).toHaveBeenCalledWith('test-key'); // Lock key должен быть 'test-key', а не 'payment:test-key'
    });

    it('should throw ConflictException if duplicate order exists', async () => {
      // Arrange
      const existingPayment = { id: 'existing-123', status: 'PENDING' };
      mockRedisService.getIdempotencyResult.mockResolvedValue(null);
      mockRedisService.acquireLock.mockResolvedValue(true);
      mockRedisService.releaseLock.mockResolvedValue(true);
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
      expect(redis.releaseLock).toHaveBeenCalled(); // Lock должен быть освобожден
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

      // Mock Redis
      mockRedisService.getIdempotencyResult.mockResolvedValue(null);
      mockRedisService.acquireLock.mockResolvedValue(true);
      mockRedisService.setIdempotencyResult.mockResolvedValue(true);
      mockRedisService.releaseLock.mockResolvedValue(true);

      // Mock Prisma
      mockPrismaService.payment.findFirst.mockResolvedValue(null);
      mockPrismaService.payment.create.mockResolvedValue(createdPayment);
      mockPrismaService.payment.update.mockResolvedValue({
        ...createdPayment,
        externalId: 'ext-123',
      });

      // Mock Yookassa
      mockYookassaService.createPayment.mockResolvedValue(yookassaResult);

      // Act
      const result = await service.createPayment(createPaymentDto);

      // Assert
      expect(redis.acquireLock).toHaveBeenCalledWith(expect.any(String), 30); // Ключ генерируется автоматически
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
        metadata: expect.objectContaining({
          internalPaymentId: 'payment-123',
          userId: 'user-123',
          orderId: 'order-456',
        }),
      });

      expect(redis.setIdempotencyResult).toHaveBeenCalledWith(
        expect.stringContaining('payment:'), // Ключ генерируется
        expect.any(Object),
        300,
      );

      expect(rabbitmq.sendToQueue).toHaveBeenCalledWith(
        'payment.created',
        expect.objectContaining({
          paymentId: 'payment-123',
          externalId: 'ext-123',
          userId: 'user-123',
          amount: 1000,
        }),
      );

      expect(redis.releaseLock).toHaveBeenCalled(); // Lock освобождается

      expect(result).toEqual({
        id: 'payment-123',
        externalId: 'ext-123',
        status: PaymentStatus.PENDING,
        confirmationUrl: 'https://payment.url',
        ...yookassaResult,
      });
    });

    it('should handle payment creation error and release lock', async () => {
      // Arrange
      const createdPayment = { id: 'payment-123' };
      const error = new Error('Yookassa API error');

      mockRedisService.getIdempotencyResult.mockResolvedValue(null);
      mockRedisService.acquireLock.mockResolvedValue(true);
      mockRedisService.releaseLock.mockResolvedValue(true);
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

      expect(redis.releaseLock).toHaveBeenCalled(); // Lock должен быть освобожден даже при ошибке
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

    it('should confirm payment successfully with subscription activation', async () => {
      // Arrange
      const payment = {
        id: 'db-123',
        externalId: 'ext-123',
        userId: 'user-123',
        isRecurring: false,
        subscriptionId: 'sub-123',
        amount: 1000,
      };

      const yookassaResult = { id: 'ext-123', status: 'succeeded' };

      mockPrismaService.payment.findUnique.mockResolvedValue(payment);
      mockYookassaService.confirmPayment.mockResolvedValue(yookassaResult);
      mockPrismaService.payment.update.mockResolvedValue({
        ...payment,
        status: PaymentStatus.SUCCEEDED,
      });

      // Mock внутренний метод activateSubscription
      const activateSubscriptionSpy = jest
        .spyOn(service as any, 'activateSubscription')
        .mockResolvedValue(undefined);

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

      expect(activateSubscriptionSpy).toHaveBeenCalledWith('sub-123');

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
      mockPrismaService.payment.update.mockResolvedValue(payment);

      // Mock внутренний метод savePaymentMethod
      const savePaymentMethodSpy = jest
        .spyOn(service as any, 'savePaymentMethod')
        .mockResolvedValue(undefined);

      // Act
      await service.confirmPayment(paymentId, confirmDto);

      // Assert
      expect(savePaymentMethodSpy).toHaveBeenCalledWith(
        'user-123',
        yookassaResult,
      );
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
      mockRedisService.releaseLock.mockResolvedValue(true);
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

      const invoice = {
        id: 'inv-123',
        amountDue: 999,
        status: InvoiceStatus.OPEN,
      };

      const payment = {
        id: 'pay-123',
        amount: 999,
        currency: 'RUB',
        status: PaymentStatus.PENDING,
      };

      const chargeResult = {
        id: 'charge-123',
        status: 'succeeded',
      };

      mockRedisService.acquireLock.mockResolvedValue(true);
      mockRedisService.releaseLock.mockResolvedValue(true);
      mockPrismaService.subscription.findUnique.mockResolvedValue(subscription);

      // Mock внутренние методы
      const createInvoiceSpy = jest
        .spyOn(service as any, 'createInvoiceForSubscription')
        .mockResolvedValue({ invoice, payment });

      const chargeMethodSpy = jest
        .spyOn(service as any, 'chargePaymentMethod')
        .mockResolvedValue(chargeResult);

      const updatePeriodSpy = jest
        .spyOn(service as any, 'updateSubscriptionPeriod')
        .mockResolvedValue(undefined);

      // Act
      const result = await service.processRecurringPayment(subscriptionId);

      // Assert
      expect(result.success).toBe(true);
      expect(createInvoiceSpy).toHaveBeenCalledWith('sub-123');
      expect(chargeMethodSpy).toHaveBeenCalledWith(
        subscription.defaultPaymentMethod,
        999,
        'RUB',
        'Подписка Premium',
        { invoiceId: 'inv-123', subscriptionId: 'sub-123' },
      );

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-123' },
        data: {
          status: PaymentStatus.SUCCEEDED,
          externalId: 'charge-123',
          capturedAt: expect.any(Date),
        },
      });

      expect(updatePeriodSpy).toHaveBeenCalledWith('sub-123');
      expect(redis.releaseLock).toHaveBeenCalled();
    });
  });

  // ========== NEW TESTS FOR NEW METHODS ==========
  describe('onModuleInit', () => {
    it('should subscribe to RabbitMQ queues', async () => {
      // Arrange
      const subscribeSpy = jest.spyOn(mockRabbitMQService, 'subscribe');

      // Act
      await service.onModuleInit();

      // Assert
      expect(subscribeSpy).toHaveBeenCalledWith(
        'payment.created',
        expect.any(Function),
      );
      expect(subscribeSpy).toHaveBeenCalledWith(
        'dunning.process_step',
        expect.any(Function),
      );
    });
  });

  describe('refundPayment', () => {
    it('should throw BadRequestException if payment not succeeded', async () => {
      // Arrange
      mockPrismaService.payment.findUnique.mockResolvedValue({
        status: PaymentStatus.PENDING,
      });

      // Act & Assert
      await expect(service.refundPayment('pay-123', 500)).rejects.toThrow(
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
        'pay-123',
        500,
        'Customer request',
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

      expect(result).toEqual(createdRefund);
    });
  });

  describe('getUserSubscriptions', () => {
    it('should return user subscriptions with invoices', async () => {
      // Arrange
      const subscriptions = [
        {
          id: 'sub-1',
          userId: 'user-123',
          invoices: [{ id: 'inv-1' }],
        },
      ];

      mockPrismaService.subscription.findMany.mockResolvedValue(subscriptions);

      // Act
      const result = await service.getUserSubscriptions('user-123');

      // Assert
      expect(prisma.subscription.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
        include: {
          invoices: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual(subscriptions);
    });
  });

  // ========== PRIVATE METHODS TESTS ==========
  describe('private methods', () => {
    describe('handleDunningStep', () => {
      it('should process dunning step successfully', async () => {
        // Arrange
        const data = { dunningId: 'dun-123' };
        const mockResult = { completed: false, nextStage: 2 };

        const processDunningStageSpy = jest
          .spyOn(service as any, 'processDunningStage')
          .mockResolvedValue(mockResult);

        // Act
        await (service as any).handleDunningStep(data);

        // Assert
        expect(processDunningStageSpy).toHaveBeenCalledWith('dun-123');
      });
    });

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

      it('should use current date if not provided', () => {
        // Act
        const result = (service as any).calculateNextBillingDate('MONTHLY');

        // Assert
        expect(result).toBeInstanceOf(Date);
      });
    });
  });
});
