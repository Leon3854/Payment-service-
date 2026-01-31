// src/payment/payment.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { CreateRefundDto } from './dto/create-refund.dto';

@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ transform: true }))
  async createPayment(@Body() createPaymentDto: CreatePaymentDto) {
    return this.paymentService.createPayment(createPaymentDto);
  }

  @Post('subscriptions')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ transform: true }))
  async createSubscription(
    @Body() createSubscriptionDto: CreateSubscriptionDto,
  ) {
    return this.paymentService.createSubscription(createSubscriptionDto);
  }

  @Get('user/:userId')
  async getUserPayments(
    @Param('userId') userId: string,
    @Query('limit') limit: string = '10',
    @Query('offset') offset: string = '0',
  ) {
    return this.paymentService.getUserPayments(
      userId,
      parseInt(limit),
      parseInt(offset),
    );
  }

  @Get('subscriptions/user/:userId')
  async getUserSubscriptions(@Param('userId') userId: string) {
    return this.paymentService.getUserSubscriptions(userId);
  }

  @Post('confirm/:paymentId')
  @UsePipes(new ValidationPipe({ transform: true }))
  async confirmPayment(
    @Param('paymentId') paymentId: string,
    @Body() confirmDto: ConfirmPaymentDto,
  ) {
    return this.paymentService.confirmPayment(paymentId, confirmDto);
  }

  @Post('cancel-subscription/:subscriptionId')
  async cancelSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: { cancelAtPeriodEnd?: boolean },
  ) {
    return this.paymentService.cancelSubscription(
      subscriptionId,
      body.cancelAtPeriodEnd,
    );
  }

  @Post('refund/:paymentId')
  @UsePipes(new ValidationPipe({ transform: true }))
  async refundPayment(
    @Param('paymentId') paymentId: string,
    @Body() refundDto: CreateRefundDto,
  ) {
    return this.paymentService.refundPayment(
      paymentId,
      refundDto.amount,
      refundDto.reason,
    );
  }

  @Get(':id')
  async getPayment(@Param('id') id: string) {
    return this.paymentService.getPaymentById(id);
  }

  @Get('subscriptions/:id')
  async getSubscription(@Param('id') id: string) {
    return await this.paymentService.getSubscriptionById(id);
  }
}
