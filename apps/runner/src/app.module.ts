import { Module } from '@nestjs/common'
import { RedisModule} from 'nestjs-redis'
import { ConfigModule } from '@nestjs/config'
import { ClientsModule, Transport } from '@nestjs/microservices'
import { CoinbaseModule } from '@momentum/coinbase'
import { CoinbaseEMA1226Controller } from './coinbase-ema1226.controller'

@Module({
  imports: [
    // Config
    ConfigModule.forRoot(),
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
      name: 'momentum-state',
      url: 'redis://localhost:6379/1',
      keyPrefix: 'mmtm'
    }),
    // Coinbase
    CoinbaseModule
  ],
  controllers: [
    CoinbaseEMA1226Controller
  ],
  providers: [],
})
export class AppModule {
  async beforeApplicationShutdown() {
    console.log('RUNNER: SHUTTING DOWN!')
    // TODO emit shutdown event?
  }
}