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

    // init existing cb subscriptions
    const cbSubs = await this.redis.smembers('subscriptions:coinbase')
    if (cbSubs.length) {
      // subscribe
      // TODO more efficient to handle all at once?
      for(const s of cbSubs) {
        await this.appSvc.subscribe(s)
      }
    }
  }

  @Get('/ping')
  async handlePing() {
      return {
          pong: new Date().getTime(),
          running: []
      }
  }

  @EventPattern('subscribe:coinbase')
  async createSubscription(pair: string) {
    // add subscription
    await this.appSvc.subscribe(pair)
    // TODO emit event?
  }

  @EventPattern('unsubscribe:coinbase')
  async delSubscription(pair: string) {
    // remove subscription
    // TODO await?
    this.appSvc.unsubscribe(pair)
    // TODO emit event?
  }

}
