// gateway/src/products/products.service.ts
import { Injectable, HttpException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Product } from './products.types';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';

@Injectable()
export class ProductsService {
  constructor(private readonly httpService: HttpService) {}

  private readonly baseUrl = process.env.PRODUCT_SERVICE_URL || 'http://product-service:3000';

  async findAll(): Promise<Product[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<Product[]>(`${this.baseUrl}/api/products`)
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Failed to fetch products',
        error.response?.status || 500
      );
    }
  }

  async findOne(id: string): Promise<Product> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<Product>(`${this.baseUrl}/api/products/${id}`)
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Product not found',
        error.response?.status || 404
      );
    }
  }

  async create(createProductInput: CreateProductInput): Promise<Product> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<Product>(`${this.baseUrl}/api/products`, createProductInput)
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Failed to create product',
        error.response?.status || 500
      );
    }
  }

  async update(id: string, updateProductInput: UpdateProductInput): Promise<Product> {
    try {
      const response = await firstValueFrom(
        this.httpService.put<Product>(`${this.baseUrl}/api/products/${id}`, updateProductInput)
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Failed to update product',
        error.response?.status || 500
      );
    }
  }

  async remove(id: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.httpService.delete(`${this.baseUrl}/api/products/${id}`)
      );
      return true;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Failed to delete product',
        error.response?.status || 500
      );
    }
  }

  async findByIds(ids: string[]): Promise<Product[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<Product[]>(`${this.baseUrl}/api/products/batch`, { ids })
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Failed to fetch products batch',
        error.response?.status || 500
      );
    }
  }
}