// gateway/src/payments/dto/create-payment.input.ts
import { InputType, Field, Float } from '@nestjs/graphql';
import { IsEnum, IsNumber, IsString, Min, IsOptional, IsArray } from 'class-validator';
import { PaymentMethod } from '../payments.types';

@InputType()
export class CreatePaymentInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @Field()
  @IsString()
  currency: string;

  @Field(() => PaymentMethod)
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field()
  @IsString()
  userId: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  orderIds?: string[];
}