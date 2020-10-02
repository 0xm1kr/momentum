import { Controller, Inject } from '@nestjs/common'
import { RedisService } from 'nestjs-redis'
import { Redis } from 'ioredis'
import { ClientProxy, EventPattern } from '@nestjs/microservices'
import { ExchangeSubscriberService } from './provider/exchange-subscriber.service'

@Controller()
export class AppController {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly redisSvc: RedisService,
    private readonly exSubSvc: ExchangeSubscriberService
  ) {}
  
  private redis: Redis

  async onApplicationBootstrap() {
    // connect to store
    this.redis = await this.redisSvc.getClient('momentum-state')

    // init cb subscriptions
    const cbSubs = await this.redis.smembers('subscriptions:coinbase')
    if (cbSubs.length) {
      // subscribe
      this.exSubSvc.subscribe(cbSubs, 'coinbase')
    }

    // init alpaca subscriptions
    const alpSubs = await this.redis.smembers('subscriptions:alpaca')
    if (alpSubs.length) {
      // subscribe
      this.exSubSvc.subscribe(alpSubs, 'alpaca')
    }
  }

  @EventPattern('subscribe')
  async createSubscription(createSub: {
    exchange: string
    pair: string
  }) {
    // add subscription
    this.exSubSvc.subscribe([ createSub.pair ], createSub.exchange)
    await this.redis.sadd(`subscriptions:${createSub.exchange}`, createSub.pair)

    // TODO emit event?
  }

  @EventPattern('unsubscribe')
  async delSubscription(delSub: {
    exchange: string
    pair: string
  }) {
    // remove subscription
    await this.redis.srem(`subscriptions:${delSub.exchange}`, delSub.pair)
    this.exSubSvc.unsubscribe([ delSub.pair ], delSub.exchange)

    // TODO emit event?
  }

}
