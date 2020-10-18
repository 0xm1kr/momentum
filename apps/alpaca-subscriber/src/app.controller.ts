import { Controller, Get, Inject } from '@nestjs/common'
import { RedisService } from 'nestjs-redis'
import { Redis } from 'ioredis'
import { ClientProxy, EventPattern } from '@nestjs/microservices'
import { AppService } from './app.service'


@Controller('/subscriber')
export class AppController {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly redisSvc: RedisService,
    private readonly appSvc: AppService
  ) {}
  
  private redis: Redis

  async onApplicationBootstrap() {
    // connect to store
    this.redis = this.redisSvc.getClient('momentum-state')

    // init existing alpaca subscriptions
    const alpSubs = await this.redis.smembers('subscriptions:alpaca')
    if (alpSubs.length) {
      // subscribe async
      // TODO more efficient to handle all at once?
      for(const s of alpSubs) {
        await this.appSvc.subscribe(s)
      }
    }
  }

  @Get('/ping')
  async handlePing() {
      return {
          pong: new Date().getTime()
          // TODO more data?
      }
  }

  @EventPattern('subscribe:alpaca')
  async createSubscription(createSub: {
    exchange: string
    pair: string
  }) {
    // add subscription
    try {
      await this.appSvc.subscribe(createSub.pair)
    } catch(err) {
      console.error(err)
    }
    // TODO emit event?
  }

  @EventPattern('unsubscribe:alpaca')
  async delSubscription(delSub: {
    exchange: string
    pair: string
  }) {
    // remove subscription
    // TODO await?
    this.appSvc.unsubscribe(delSub.pair)
    // TODO emit event?
  }

}
