// src/payment/enums/payment.enum.ts

export enum PaymentProvider {
  YOOKASSA = 'YOOKASSA',
  STRIPE = 'STRIPE',
  PAYPAL = 'PAYPAL',
  SBERBANK = 'SBERBANK',
  TINKOFF = 'TINKOFF',
  MANUAL = 'MANUAL', // Для тестов/ручных операций
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  REQUIRES_ACTION = 'REQUIRES_ACTION', // Требует 3D Secure
  AWAITING_CAPTURE = 'AWAITING_CAPTURE',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  WAITING_FOR_CAPTURE = 'WAITING_FOR_CAPTURE',
  DISPUTED = 'DISPUTED', // Оспорен
}

export enum SubscriptionStatus {
  PENDING = 'PENDING', // Создана, ожидает первый платеж
  ACTIVE = 'ACTIVE', // Активна
  PAST_DUE = 'PAST_DUE', // Просрочена
  CANCELED = 'CANCELED', // Отменена
  UNPAID = 'UNPAID', // Не оплачена (даннинг завершен)
  INCOMPLETE = 'INCOMPLETE', // Первый платеж не завершен
  INCOMPLETE_EXPIRED = 'INCOMPLETE_EXPIRED', // Истек срок первого платежа
  TRIALING = 'TRIALING', // Триальный период
  PAUSED = 'PAUSED', // Приостановлена
}

export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  OPEN = 'OPEN',
  PAID = 'PAID',
  UNCOLLECTIBLE = 'UNCOLLECTIBLE', // Безнадежный долг
  VOID = 'VOID',
}

export enum BillingCycle {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  YEARLY = 'YEARLY',
  CUSTOM = 'CUSTOM',
}

export enum RefundStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED',
}

export enum PaymentMethodType {
  CARD = 'CARD',
  BANK_TRANSFER = 'BANK_TRANSFER',
  DIGITAL_WALLET = 'DIGITAL_WALLET', // Apple Pay, Google Pay
  MOBILE = 'MOBILE', // Мобильные платежи
  CRYPTO = 'CRYPTO',
  CASH = 'CASH',
  SBP = 'SBP', // Система быстрых платежей
}

export enum DunningStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}
