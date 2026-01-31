// gateway/src/payments/payments.service.ts
import { Injectable, HttpException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CreatePaymentInput } from './dto/create-payment.input';
import { Payment, PaymentResult, PaymentStatus } from './payments.types';

@Injectable()
export class PaymentsService {
  constructor(private readonly httpService: HttpService) {}

  private readonly baseUrl = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3000';

  async create(createPaymentInput: CreatePaymentInput): Promise<PaymentResult> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<PaymentResult>(
          `${this.baseUrl}/api/payments`,
          createPaymentInput
        )
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Payment creation failed',
        error.response?.status || 500
      );
    }
  }

  async findOne(id: string): Promise<Payment> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<Payment>(`${this.baseUrl}/api/payments/${id}`)
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Payment not found',
        error.response?.status || 404
      );
    }
  }

  async findByUser(userId: string): Promise<Payment[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<Payment[]>(`${this.baseUrl}/api/payments/user/${userId}`)
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Failed to fetch user payments',
        error.response?.status || 500
      );
    }
  }

  async updateStatus(id: string, status: PaymentStatus): Promise<Payment> {
    try {
      const response = await firstValueFrom(
        this.httpService.patch<Payment>(
          `${this.baseUrl}/api/payments/${id}/status`,
          { status }
        )
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Failed to update payment status',
        error.response?.status || 500
      );
    }
  }
}