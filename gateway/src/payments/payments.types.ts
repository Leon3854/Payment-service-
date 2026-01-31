// gateway/src/payments/payments.types.ts
import { ObjectType, Field, ID, Float, registerEnumType } from '@nestjs/graphql';
import { User } from '../../auth/auth.types';
import { Product } from '../../products/products.types';

// =========== ENUMS ===========
export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  CANCELLED = 'CANCELLED',
}

export enum PaymentMethod {
  CREDIT_CARD = 'CREDIT_CARD',
  DEBIT_CARD = 'DEBIT_CARD',
  PAYPAL = 'PAYPAL',
  BANK_TRANSFER = 'BANK_TRANSFER',
  APPLE_PAY = 'APPLE_PAY',
  GOOGLE_PAY = 'GOOGLE_PAY',
  CRYPTO = 'CRYPTO',
  CASH = 'CASH',
}

export enum Currency {
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  RUB = 'RUB',
  KZT = 'KZT',
}

// Регистрируем enum'ы для GraphQL
registerEnumType(PaymentStatus, {
  name: 'PaymentStatus',
  description: 'Статусы платежей',
});

registerEnumType(PaymentMethod, {
  name: 'PaymentMethod',
  description: 'Методы оплаты',
});

registerEnumType(Currency, {
  name: 'Currency',
  description: 'Валюты',
});

// =========== TYPES ===========
@ObjectType()
export class Payment {
  @Field(() => ID)
  id: string;

  @Field(() => Float)
  amount: number;

  @Field(() => Currency)
  currency: Currency;

  @Field(() => PaymentStatus)
  status: PaymentStatus;

  @Field(() => PaymentMethod)
  method: PaymentMethod;

  @Field({ nullable: true, description: 'Описание платежа' })
  description?: string;

  @Field({ nullable: true, description: 'Сообщение об ошибке' })
  errorMessage?: string;

  @Field({ nullable: true, description: 'ID транзакции у провайдера' })
  transactionId?: string;

  @Field({ description: 'ID пользователя' })
  userId: string;

  @Field(() => [String], { nullable: true, description: 'ID заказов' })
  orderIds?: string[];

  @Field(() => [String], { nullable: true, description: 'ID товаров' })
  productIds?: string[];

  @Field({ description: 'Дата создания' })
  createdAt: Date;

  @Field({ description: 'Дата обновления' })
  updatedAt: Date;

  @Field({ nullable: true, description: 'Дата завершения' })
  completedAt?: Date;

  // Relations (будут заполнены field resolvers)
  @Field(() => User, { nullable: true })
  user?: User;

  @Field(() => [Product], { nullable: true })
  products?: Product[];

  @Field(() => [Product], { nullable: true })
  orders?: Product[]; // Используем Product для упрощения
}

@ObjectType()
export class PaymentResult {
  @Field(() => Payment)
  payment: Payment;

  @Field({ nullable: true, description: 'URL для оплаты (если нужен redirect)' })
  paymentUrl?: string;

  @Field({ nullable: true, description: 'Client secret для Stripe и подобных' })
  clientSecret?: string;

  @Field({ nullable: true, description: 'Код для QR оплаты' })
  qrCode?: string;

  @Field({ description: 'Успешность создания платежа' })
  success: boolean;

  @Field({ nullable: true })
  message?: string;
}

@ObjectType()
export class PaymentStatistics {
  @Field(() => Float)
  totalAmount: number;

  @Field(() => Float)
  averageAmount: number;

  @Field()
  totalCount: number;

  @Field(() => [PaymentStatusCount])
  byStatus: PaymentStatusCount[];

  @Field(() => [PaymentMethodCount])
  byMethod: PaymentMethodCount[];
}

@ObjectType()
export class PaymentStatusCount {
  @Field(() => PaymentStatus)
  status: PaymentStatus;

  @Field()
  count: number;

  @Field(() => Float)
  amount: number;
}

@ObjectType()
export class PaymentMethodCount {
  @Field(() => PaymentMethod)
  method: PaymentMethod;

  @Field()
  count: number;

  @Field(() => Float)
  amount: number;
}

@ObjectType()
export class RefundResult {
  @Field(() => Payment)
  payment: Payment;

  @Field()
  success: boolean;

  @Field({ nullable: true })
  refundId?: string;

  @Field({ nullable: true })
  message?: string;
}

// =========== INPUT TYPES ===========
@ObjectType()
export class PaymentWebhookData {
  @Field()
  paymentId: string;

  @Field(() => PaymentStatus)
  newStatus: PaymentStatus;

  @Field({ nullable: true })
  transactionId?: string;

  @Field({ nullable: true })
  metadata?: string;
}

// =========== INTERFACES ===========
export interface PaymentCreateParams {
  amount: number;
  currency: Currency;
  method: PaymentMethod;
  userId: string;
  description?: string;
  orderIds?: string[];
  productIds?: string[];
  metadata?: Record<string, any>;
}

export interface PaymentUpdateParams {
  status?: PaymentStatus;
  transactionId?: string;
  errorMessage?: string;
  metadata?: Record<string, any>;
}