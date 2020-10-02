import { Module } from '@nestjs/common'
import { RedisModule} from 'nestjs-redis'
import { ConfigModule } from '@nestjs/config'
import { CoinbaseModule } from '@momentum/coinbase'
import { AppController } from './app.controller'

@Module({
  imports: [
    // Config
    ConfigModule.forRoot(),
    // Redis as a simple DB service
    RedisModule.register({
      name: 'momentum-state',
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