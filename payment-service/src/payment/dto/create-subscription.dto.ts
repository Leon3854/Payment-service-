// src/payment/dto/create-subscription.dto.ts
import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsObject,
  Min,
  IsInt,
} from 'class-validator';
import { BillingCycle } from '../enums/payment.enum';

export class CreateSubscriptionDto {
  @IsString()
  userId: string;

  @IsString()
  planId: string;

  @IsString()
  planName: string;

  @IsNumber()
  @Min(1)
  price: number;

  @IsEnum(BillingCycle)
  billingCycle: BillingCycle = BillingCycle.MONTHLY;

  @IsInt()
  @Min(0)
  @IsOptional()
  trialDays?: number = 0;

  @IsInt()
  @Min(1)
  @IsOptional()
  quantity?: number = 1;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;

  @IsString()
  @IsOptional()
  paymentMethodId?: string; // Сохраненный метод оплаты
}
