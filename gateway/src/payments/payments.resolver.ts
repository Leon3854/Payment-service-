// gateway/src/payments/payments.resolver.ts
import { Resolver, Query, Mutation, Args, ResolveField, Parent, Context } from '@nestjs/graphql';
import { PaymentsService } from './payments.service';
import { Payment, PaymentResult, PaymentStatus } from './payments.types';
import { CreatePaymentInput } from './dto/create-payment.input';
import { AuthService } from '../auth/auth.service';
import { ProductsService } from '../products/products.service';

@Resolver(() => Payment)
export class PaymentsResolver {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly authService: AuthService,
    private readonly productsService: ProductsService,
  ) {}

  // =========== QUERIES ===========
  @Query(() => Payment, { nullable: true })
  async payment(@Args('id') id: string): Promise<Payment> {
    return this.paymentsService.findOne(id);
  }

  @Query(() => [Payment])
  async payments(): Promise<Payment[]> {
    // Если нужно получить все платежи (админская функция)
    // В реальном приложении добавьте проверку прав
    throw new Error('Not implemented - use paymentsByUser instead');
  }

  @Query(() => [Payment])
  async paymentsByUser(@Args('userId') userId: string): Promise<Payment[]> {
    return this.paymentsService.findByUser(userId);
  }

  // =========== MUTATIONS ===========
  @Mutation(() => PaymentResult)
  async createPayment(
    @Args('createPaymentInput') createPaymentInput: CreatePaymentInput,
  ): Promise<PaymentResult> {
    return this.paymentsService.create(createPaymentInput);
  }

  @Mutation(() => Payment)
  async updatePaymentStatus(
    @Args('id') id: string,
    @Args('status', { type: () => PaymentStatus }) status: PaymentStatus,
  ): Promise<Payment> {
    return this.paymentsService.updateStatus(id, status);
  }

  @Mutation(() => Boolean)
  async cancelPayment(@Args('id') id: string): Promise<boolean> {
    await this.paymentsService.updateStatus(id, PaymentStatus.FAILED);
    return true;
  }

  @Mutation(() => Payment)
  async refundPayment(
    @Args('id') id: string,
    @Args('reason', { nullable: true }) reason?: string,
  ): Promise<Payment> {
    // В реальном приложении добавьте логику возврата
    return this.paymentsService.updateStatus(id, PaymentStatus.REFUNDED);
  }

  // =========== FIELD RESOLVERS ===========
  @ResolveField()
  async user(@Parent() payment: Payment) {
    try {
      return await this.authService.getUserById(payment.userId);
    } catch (error) {
      console.error(`Failed to fetch user ${payment.userId}:`, error.message);
      return null;
    }
  }

  @ResolveField()
  async orders(@Parent() payment: Payment, @Context() context) {
    if (!payment.orderIds || payment.orderIds.length === 0) {
      return [];
    }
    
    // Используем dataloader для эффективной загрузки
    const productLoader = context.loaders?.productLoader;
    if (productLoader) {
      return productLoader.loadMany(payment.orderIds);
    }
    
    // Fallback: загружаем напрямую
    return this.productsService.findByIds(payment.orderIds);
  }

  @ResolveField()
  async statusDescription(@Parent() payment: Payment): Promise<string> {
    const statusDescriptions = {
      [PaymentStatus.PENDING]: 'Ожидает оплаты',
      [PaymentStatus.COMPLETED]: 'Оплачен успешно',
      [PaymentStatus.FAILED]: 'Ошибка оплаты',
      [PaymentStatus.REFUNDED]: 'Возврат осуществлен',
    };
    
    return statusDescriptions[payment.status] || 'Неизвестный статус';
  }

  @ResolveField()
  async isRefundable(@Parent() payment: Payment): Promise<boolean> {
    // Логика определения можно ли вернуть платеж
    const refundableStatuses = [PaymentStatus.COMPLETED];
    const hoursSincePayment = (Date.now() - new Date(payment.createdAt).getTime()) / (1000 * 60 * 60);
    
    return (
      refundableStatuses.includes(payment.status) && 
      hoursSincePayment < 24 // Можно вернуть в течение 24 часов
    );
  }
}