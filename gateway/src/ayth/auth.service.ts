// gateway/src/auth/auth.service.ts
import { Injectable, HttpException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { LoginInput } from './dto/login.input';
import { RegisterInput } from './dto/register.input';
import { User, AuthPayload } from './auth.types';

@Injectable()
export class AuthService {
  constructor(private readonly httpService: HttpService) {}

  private readonly baseUrl = process.env.AUTH_SERVICE_URL || 'http://auth-service:3000';

  async login(loginInput: LoginInput): Promise<AuthPayload> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<AuthPayload>(`${this.baseUrl}/api/auth/login`, loginInput)
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Login failed',
        error.response?.status || 500
      );
    }
  }

  async register(registerInput: RegisterInput): Promise<AuthPayload> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<AuthPayload>(`${this.baseUrl}/api/auth/register`, registerInput)
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Registration failed',
        error.response?.status || 500
      );
    }
  }

  async validateToken(token: string): Promise<User> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<User>(`${this.baseUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` }
        })
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Invalid token',
        error.response?.status || 401
      );
    }
  }

  async getUserById(id: string): Promise<User> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<User>(`${this.baseUrl}/api/auth/users/${id}`)
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'User not found',
        error.response?.status || 404
      );
    }
  }

  async getUsersByIds(ids: string[]): Promise<User[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<User[]>(`${this.baseUrl}/api/auth/users/batch`, { ids })
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        error.response?.data?.message || 'Failed to fetch users',
        error.response?.status || 500
      );
    }
  }
}