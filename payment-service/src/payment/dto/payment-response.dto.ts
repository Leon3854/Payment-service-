import { PaymentEntity, PaymentStatus } from '../entities/payment.entity';

// dto/payment-response.dto.ts
export class PaymentResponseDto {
  id: string;
  orderId: string;
  userId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  clientSecret?: string;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(entity: PaymentEntity): PaymentResponseDto {
    return {
      id: entity.id,
      orderId: entity.orderId,
      userId: entity.userId,
      amount: entity.amount,
      currency: entity.currency,
      status: entity.status,
      clientSecret: entity.clientSecret,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
