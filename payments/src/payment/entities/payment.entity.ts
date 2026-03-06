import { randomUUID } from 'crypto';

// entities/payment.entity.ts
export class PaymentEntity {
  constructor(
    public readonly id: string,
    public readonly orderId: string,
    public readonly userId: string,
    public readonly amount: number,
    public readonly currency: string,
    public status: PaymentStatus,
    public provider: string,
    public providerPaymentId?: string,
    public clientSecret?: string,
    public readonly createdAt: Date = new Date(),
    public updatedAt: Date = new Date(),
  ) {}

  canBeConfirmed(): boolean {
    return this.status === PaymentStatus.PENDING;
  }

  markAsSucceeded(providerPaymentId: string) {
    this.status = PaymentStatus.SUCCEEDED;
    this.providerPaymentId = providerPaymentId;
    this.updatedAt = new Date();
  }

  markAsFailed() {
    this.status = PaymentStatus.FAILED;
    this.updatedAt = new Date();
  }

  static create(props: {
    id?: string;
    orderId: string;
    userId: string;
    amount: number;
    currency?: string;
    status?: PaymentStatus;
  }): PaymentEntity {
    return new PaymentEntity(
      props.id || randomUUID(),
      props.orderId,
      props.userId,
      props.amount,
      props.currency || 'RUB',
      props.status || PaymentStatus.PENDING,
      'STRIPE',
    );
  }
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED',
  REFUNDED = 'REFUNDED',
}
