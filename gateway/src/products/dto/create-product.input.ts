// gateway/src/products/dto/create-product.input.ts
import { InputType, Field, Int } from '@nestjs/graphql';
import { IsString, IsNumber, Min, IsOptional } from 'class-validator';

@InputType()
export class CreateProductInput {
  @Field()
  @IsString()
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => Int)
  @IsNumber()
  @Min(0)
  price: number;

  @Field()
  @IsString()
  category: string;
}