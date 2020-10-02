import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { RedisService } from 'nestjs-redis'
import { Redis } from 'ioredis';
import { ClientProxy } from '@nestjs/microservices';
import { AlgorithmStartEvent } from '@momentum/events'

@Controller()
export class AppController {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly redisSvc: RedisService
  ) {}

  private redis: Redis

  async onApplicationBootstrap() {
    // connect to store
    this.redis = await this.redisSvc.getClient('momentum-state')

    // DEV ONLY
    await this.redis.flushall()
  }

  @Get('/subscriptions')
  async getSubscriptions() {
    const keys = await this.redis.keys('subscriptions:*')

    return Promise.all(
      keys.map(async (k: string) => {
        const params = k.split(':')
        return {
          exchange: params[1],
          pairs: await this.redis.smembers(k)
        }
      })
    )
  }

  @Post('/subscriptions')
  async createSubscription(@Body() createSub: {
    exchange: string
    pair: string
  }) {
    this.momentum.emit('subscribe', createSub)

    return {
      message: `Subscribing to ${createSub.exchange}:${createSub.pair}`
    }
  }

  @Delete('/subscriptions')
  async delSubscription(@Body() delSub: {
    exchange: string
    pair: string
  }) {
    this.momentum.emit('unsubscribe', delSub)

    return {
      message: `Unsubscribing from ${delSub.exchange}:${delSub.pair}`
    }
  }

  @Get('/algorithms')
  async getAlgos() {
    const keys = await this.redis.keys('algorithms:*')

    return Promise.all(
      keys.map(async (k: string) => {
        const params = k.split(':')
        return {
          exchange: params[1],
          algorithm: params[2],
          pairs: await this.redis.smembers(k)
        }
      })
    )
  }

  @Get('/algorithms/:algo')
  async getAlgorithm(@Param() params) {
    const keys = await this.redis.keys(`algorithms:${params.algo}:*`)
    return await Promise.all(
      keys.map(async (k) => {
        const res = JSON.parse(await this.redis.get(k))
        return {
          [k]: res
        }
      })
    )
  }

  @Post('/algorithms')
  async createAlgo(@Param() params, @Body() createAlgorithm: AlgorithmStartEvent) {

    await this.redis.sadd('algorithms:coinbase', params.algo)

    await this.momentum.emit(
      `start:${params.algo}`,
      new AlgorithmStartEvent(
        createAlgorithm.pair, 
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
