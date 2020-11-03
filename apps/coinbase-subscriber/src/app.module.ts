import { Module } from '@nestjs/common'
import { Transport, ClientsModule } from '@nestjs/microservices'
import { ConfigModule } from '@nestjs/config'
import { RedisModule} from 'nestjs-redis'
import { CoinbaseModule } from '@momentum/coinbase-client'
import { ClockModule } from '@momentum/clock'
import { AppService } from './app.service'
import { AppController } from './app.controller'
import { EMA1226Controller } from './ema1226.controller'

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('events').EventEmitter.prototype._maxListeners = 100;

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
    // Clock
    ClockModule,
    // Coinbase
    CoinbaseModule
  ],
  providers: [
    AppService
  ],
  controllers: [
    AppController,
    EMA1226Controller
  ]
})
export class AppModule {
  async beforeApplicationShutdown() {
    console.log('SUBSCRIBER: SHUTTING DOWN!')
    // TODO emit shutdown event?
  }
}
