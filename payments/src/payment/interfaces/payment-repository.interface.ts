// interfaces/payment-repository.interface.ts
import { PaymentEntity, PaymentStatus } from '../entities/payment.entity';

export interface IPaymentRepository {
  create(payment: PaymentEntity): Promise<PaymentEntity>;
  findById(id: string): Promise<PaymentEntity | null>;
  findByOrderId(orderId: string): Promise<PaymentEntity | null>;
  update(payment: PaymentEntity): Promise<PaymentEntity>;
  updateStatus(
    paymentId: string,
    status: PaymentStatus,
  ): Promise<PaymentEntity>;
}
