// gateway/src/common/http-client.ts
import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosRequestConfig } from 'axios';

@Injectable()
export class HttpClient {
  constructor(private readonly httpService: HttpService) {}

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<T>(url, config)
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async post<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<T>(url, data, config)
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async put<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.httpService.put<T>(url, data, config)
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async delete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.httpService.delete<T>(url, config)
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  private handleError(error: any): Error {
    console.error('HTTP Client Error:', {
      url: error.config?.url,
      method: error.config?.method,
      status: error.response?.status,
      data: error.response?.data,
    });

    if (error.response) {
      throw new Error(
        `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
      );
    }

    throw new Error(`Network error: ${error.message}`);
  }
}