// gateway/src/products/products.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProductsResolver } from './products.resolver';
import { ProductsService } from './products.service';

@Module({
  imports: [
    HttpModule.registerAsync({
      useFactory: () => ({
        timeout: 5000,
        maxRedirects: 5,
        baseURL: process.env.PRODUCT_SERVICE_URL || 'http://product-service:3000',
      }),
    }),
  ],
  providers: [ProductsResolver, ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}