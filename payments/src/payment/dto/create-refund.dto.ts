// src/payment/dto/create-refund.dto.ts
import { IsNumber, IsString, IsOptional, Min } from 'class-validator';

export class CreateRefundDto {
  @IsNumber()
  @Min(1)
  @IsOptional()
  amount?: number;

  @IsString()
  @IsOptional()
  reason?: string;
}
