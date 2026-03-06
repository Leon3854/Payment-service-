import { Module } from '@nestjs/common';
import { YookassaService } from './yookassa.service';

@Module({
  providers: [YookassaService],
})
export class YookassaModule {}
