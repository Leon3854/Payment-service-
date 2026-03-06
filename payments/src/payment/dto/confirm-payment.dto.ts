// src/payment/dto/confirm-payment.dto.ts
import { IsString, IsOptional, IsObject } from 'class-validator';

export class ConfirmPaymentDto {
  @IsString()
  @IsOptional()
  paymentMethodId?: string;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}
