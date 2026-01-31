// gateway/src/products/products.types.ts
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

@ObjectType()
export class Product {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  description: string;

  @Field(() => Int)
  price: number;

  @Field()
  category: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}