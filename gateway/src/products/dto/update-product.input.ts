// gateway/src/products/dto/update-product.input.ts
import { InputType, Field, Int, PartialType } from '@nestjs/graphql';
import { CreateProductInput } from './create-product.input';

@InputType()
export class UpdateProductInput extends PartialType(CreateProductInput) {}