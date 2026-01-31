// gateway/src/auth/auth.resolver.ts
import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { AuthService } from './auth.service';
import { AuthPayload, User } from './auth.types';

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Mutation(() => AuthPayload)
  async login(
    @Args('email') email: string,
    @Args('password') password: string,
  ): Promise<AuthPayload> {
    return this.authService.login(email, password);
  }

  @Mutation(() => AuthPayload)
  async register(
    @Args('email') email: string,
    @Args('password') password: string,
    @Args('name', { nullable: true }) name?: string,
  ): Promise<AuthPayload> {
    return this.authService.register(email, password, name);
  }

  @Query(() => User, { nullable: true })
  async me(@Args('token') token: string) {
    return this.authService.validateToken(token);
  }
}