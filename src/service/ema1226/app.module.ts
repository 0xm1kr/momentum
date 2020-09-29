import { Module } from '@nestjs/common';
import { AppController } from './app.controller'
import { RedisModule} from 'nestjs-redis'
import { CoinbaseModule } from '../../shared/module/coinbase/coinbase.module';

@Module({
  imports: [
    // Redis as a simple DB service
    RedisModule.register({
      name: 'momentum',
      url: 'redis://localhost:6379/1',
      keyPrefix: 'mmtm'
    }),
    // Coinbase
    CoinbaseModule
  ],
  controllers: [
    AppController
  ],
  providers: [],
})
export class AppModule {}