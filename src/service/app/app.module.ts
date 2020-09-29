import { Module } from '@nestjs/common';
import { Transport, ClientsModule } from '@nestjs/microservices';
import { RedisModule} from 'nestjs-redis'
import { CoinbaseModule } from '../../shared/module/coinbase/coinbase.module';
import { AlpacaModule } from '../../shared/module/alpaca/alpaca.module';
import { ExchangeSubscriberService } from './provider/exchange-subscriber.service';
import { AppController } from './app.controller';

@Module({
  imports: [
    // Momentum events service
    ClientsModule.register([
      {
        name: 'MOMENTUM_SERVICE',
        transport: Transport.REDIS,
        options: {
          url: 'redis://localhost:6379',
          db: '0'
        }
      },
    ]),
    // Redis as a simple DB service
    RedisModule.register({
      name: 'momentum',
      url: 'redis://localhost:6379/1',
      keyPrefix: 'mmtm'
    }),
    // Coinbase
    CoinbaseModule,
    // Alpaca
    AlpacaModule
  ],
  providers: [
    ExchangeSubscriberService
  ],
  controllers: [
    AppController
  ]
})
export class AppModule {}
