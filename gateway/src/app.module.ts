// gateway/src/app.module.ts
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';

// Modules
import { AuthModule } from './auth/auth.module';
import { ProductsModule } from './products/products.module';
import { PaymentsModule } from './payments/payments.module';

// Resolvers
import { AuthResolver } from './auth/auth.resolver';
import { ProductsResolver } from './products/products.resolver';
import { PaymentsResolver } from './payments/payments.resolver';

// Services
import { AuthService } from './auth/auth.service';
import { ProductsService } from './products/products.service';
import { PaymentsService } from './payments/payments.service';

// Common
import { DataLoaders } from './common/dataloaders';
import { HttpClient } from './common/http-client';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
    
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      playground: true,
      introspection: true,
      context: ({ req }) => ({
        req,
        loaders: {
          userLoader: null, // Инициализируются в DataLoaders
          productLoader: null,
        },
      }),
    }),
    
    // Feature modules
    AuthModule,
    ProductsModule,
    PaymentsModule,
  ],
  providers: [
    // Resolvers
    AuthResolver,
    ProductsResolver,
    PaymentsResolver,
    
    // Services
    AuthService,
    ProductsService,
    PaymentsService,
    
    // Common utilities
    DataLoaders,
    HttpClient,
  ],
})
export class AppModule {}