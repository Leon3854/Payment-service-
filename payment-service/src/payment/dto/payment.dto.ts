// src/payment/dto/payment.dto.ts
export class CreatePaymentDto {
  amount: {
    value: number;
    currency: string;
  };
  payment_method_data: {
    type: string;
  };
  confirmation: {
    type: string;
    return_url: string;
  };
  description: string;
  metadata: PaymentMetadata;
  capture?: boolean;
  receipt?: ReceiptDto;
}

export class ConfirmPaymentDto {
  paymentId: string;
}

export class CreateRefundDto {
  payment_id: string;
  amount: {
    value: number;
    currency: string;
  };
  description?: string;
}

export class WebhookEventDto {
  type: string;
  event: string;
  object: any;
}

export interface PaymentMetadata {
  userId: string;
  orderId: string;
  [key: string]: any;
}

export interface ReceiptDto {
  customer: {
    email: string;
  };
  items: Array<{
    description: string;
    quantity: string;
    amount: {
      value: string;
      currency: string;
    };
    vat_code: number;
    payment_mode: string;
    payment_subject: string;
  }>;
}
