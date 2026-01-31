// gateway/src/auth/auth.types.ts
import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class User {
  @Field(() => ID)
  id: string;

  @Field()
  email: string;

  @Field({ nullable: true })
  name?: string;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class AuthPayload {
  @Field()
  token: string;

  @Field(() => User)
  user: User;
}