// gateway/src/common/dataloaders.ts
import DataLoader from 'dataloader';
import { Injectable } from '@nestjs/common';
import { HttpClient } from './http-client';

@Injectable()
export class DataLoaders {
  private userLoader: DataLoader<string, any>;
  private productLoader: DataLoader<string, any>;

  constructor(private readonly httpClient: HttpClient) {
    this.userLoader = new DataLoader(this.batchUsers.bind(this));
    this.productLoader = new DataLoader(this.batchProducts.bind(this));
  }

  private async batchUsers(userIds: string[]) {
    const users = await this.httpClient.post<any[]>(
      `${process.env.AUTH_SERVICE_URL}/api/auth/users/batch`,
      { ids: userIds }
    );
    
    const userMap = new Map();
    users.forEach(user => userMap.set(user.id, user));
    
    return userIds.map(id => userMap.get(id) || null);
  }

  private async batchProducts(productIds: string[]) {
    const products = await this.httpClient.post<any[]>(
      `${process.env.PRODUCT_SERVICE_URL}/api/products/batch`,
      { ids: productIds }
    );
    
    const productMap = new Map();
    products.forEach(product => productMap.set(product.id, product));
    
    return productIds.map(id => productMap.get(id) || null);
  }

  getUserLoader(): DataLoader<string, any> {
    return this.userLoader;
  }

  getProductLoader(): DataLoader<string, any> {
    return this.productLoader;
  }
}