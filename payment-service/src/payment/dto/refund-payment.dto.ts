// src/payment/dto/refund-payment.dto.ts
import { IsString, IsOptional } from 'class-validator';

export class RefundPaymentDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
