// gateway/src/products/products.resolver.ts
import { Resolver, Query, Args, ResolveField, Parent } from '@nestjs/graphql';
import { ProductsService } from './products.service';
import { Product } from './products.types';

@Resolver(() => Product)
export class ProductsResolver {
  constructor(private readonly productsService: ProductsService) {}

  @Query(() => [Product])
  async products() {
    return this.productsService.findAll();
  }

  @Query(() => Product, { nullable: true })
  async product(@Args('id') id: string) {
    return this.productsService.findOne(id);
  }

  // Пример field resolver для связанных данных
  @ResolveField()
  async relatedProducts(@Parent() product: Product) {
    // Можно добавить логику для related products
    const allProducts = await this.productsService.findAll();
    return allProducts.filter(p => 
      p.category === product.category && p.id !== product.id
    ).slice(0, 3);
  }
}