import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { RedisService } from 'nestjs-redis'
import { Redis } from 'ioredis';
import { ClientProxy } from '@nestjs/microservices';
import { ExchangeSubscriberService } from './provider/exchange-subscriber.service';
import { AlgorithmStartEvent } from '../../shared/event/algorithm-start.event'

@Controller()
export class AppController {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly redisSvc: RedisService,
    private readonly esSvc: ExchangeSubscriberService
  ) {}

  private redis: Redis

  async onApplicationBootstrap() {
    // connect to store
    this.redis = await this.redisSvc.getClient('momentum')
    // emit timeintervals
    setInterval(() => this.momentum.emit('interval:1m', {}), 60 * 1000)
    setInterval(() => this.momentum.emit('interval:5m', {}), 60 * 1000 * 5)
    setInterval(() => this.momentum.emit('interval:15m', {}), 60 * 1000 * 15)
  }

  @Get('/subscriptions')
  async getSubscriptions() {
    return await this.redis.smembers('coinbase:subscriptions')
  }

  // TODO POST
  @Post('/subscriptions')
  async createSubscription(@Body() createSub: {
    productId: string
  }) {

    // add subscription
    await this.redis.sadd('coinbase:subscriptions', createSub.productId)
    const cbSubs = await this.redis.smembers('coinbase:subscriptions')
    this.esSvc.subscribe(cbSubs)

    return {
      subscriptions: cbSubs
    }
  }

  @Delete('/subscriptions')
  async delSubscription(@Body() delSub: {
    productId: string
  }) {
    this.esSvc.unsubscribe([delSub.productId])
    await this.redis.srem('coinbase:subscriptions', delSub.productId)
    const cbSubs = await this.redis.smembers('coinbase:subscriptions')

    return {
      message: 'Successfully unsubscribed',
      subscriptions: cbSubs
    }
  }

  @Get('/algorithms')
  async getAlgos() {
    const algos = await this.redis.smembers('algorithms:coinbase')
    return algos
  }

  @Get('/algorithms/:algo')
  async getAlgorithm(@Param() params) {
    const keys = await this.redis.keys(`algorithm:${params.algo}:*`)
    return await Promise.all(
      keys.map(async (k) => {
        const res = JSON.parse(await this.redis.get(k))
        return {
          [k]: res
        }
      })
    )
  }

  @Post('/algorithms/:algo')
  async createAlgo(@Param() params, @Body() createAlgorithm: AlgorithmStartEvent) {

    await this.redis.sadd('algorithms:coinbase', params.algo)

    await this.momentum.emit(
      `start:${params.algo}`,
      new AlgorithmStartEvent(
        createAlgorithm.productId, 
        createAlgorithm.size, 
        createAlgorithm.lastTrade
      )
    )

    return {
      message: `Algorithm starting: ${JSON.stringify(createAlgorithm)}`
    }
  }

  @Delete('/algorithms/:algo')
  async stopAlgo(@Param() params) {

    await this.redis.srem('algorithms:coinbase', params.algo)
    await this.momentum.emit(`stop:${params.algo}`, {})

    return {
      message: `Algorithm stopping: ${params.algo}`
    }
  }

}
