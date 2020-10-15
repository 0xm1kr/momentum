import { Controller, Get, Inject } from '@nestjs/common'
import { RedisService } from 'nestjs-redis'
import { Redis } from 'ioredis'
import { ClientProxy, EventPattern } from '@nestjs/microservices'
import { ExchangeSubscriberService } from './provider/exchange-subscriber.service'


@Controller('/subscriber')
export class AppController {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly redisSvc: RedisService,
    private readonly exSubSvc: ExchangeSubscriberService
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
        await this.exSubSvc.subscribe(s, 'coinbase')
      }
    }

    // init existing alpaca subscriptions
    const alpSubs = await this.redis.smembers('subscriptions:alpaca')
    if (alpSubs.length) {
      // subscribe async
      // TODO more efficient to handle all at once?
      for(const s of alpSubs) {
        await this.exSubSvc.subscribe(s, 'alpaca')
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

  @EventPattern('subscribe')
  async createSubscription(createSub: {
    exchange: string
    pair: string
  }) {
    // add subscription
    await this.exSubSvc.subscribe(createSub.pair, createSub.exchange)
    // TODO emit event?
  }

  @EventPattern('unsubscribe')
  async delSubscription(delSub: {
    exchange: string
    pair: string
  }) {
    // remove subscription
    // TODO await?
    this.exSubSvc.unsubscribe(delSub.pair, delSub.exchange)
    // TODO emit event?
  }

}
