// src/payment/dto/create-payment.dto.ts
import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsObject,
  IsBoolean,
  Min,
} from 'class-validator';
// import { Type } from 'class-transformer';
import { PaymentProvider } from '../enums/payment.enum';

export class CreatePaymentDto {
  @IsNumber()
  @Min(1)
  amount: number;

  @IsString()
  @IsOptional()
  currency?: string = 'RUB';

  @IsString()
  userId: string;

  @IsString()
  @IsOptional()
  orderId?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(PaymentProvider)
  @IsOptional()
  provider?: PaymentProvider = PaymentProvider.YOOKASSA;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;

  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean = false;

  @IsString()
  @IsOptional()
  idempotencyKey?: string;

  @IsString()
  @IsOptional()
  returnUrl?: string;
}
