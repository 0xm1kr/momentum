import { Body, Controller, Delete, Get, Inject, Post, HttpException } from '@nestjs/common';
import { RedisService } from 'nestjs-redis';
import { Redis } from 'ioredis';
import { ClientProxy } from '@nestjs/microservices';
import { AlgorithmEvent } from '@momentum/events'
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly appSvc: AppService,
    private readonly redisSvc: RedisService
  ) { }

  private redis: Redis

  async onApplicationBootstrap() {
    // connect to store
    this.redis = await this.redisSvc.getClient('momentum-state')

    // DEV ONLY
    // await this.redis.flushall()
  }

  @Get('/subscriptions')
  async getSubscriptions() {
    return this.appSvc.getSubscriptions()
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
      keys.map(async (k: string) => (this.redis.hgetall(k)))
    )
  }

  @Post('/algorithms')
  async createAlgo(@Body() algorithm: AlgorithmEvent) {

    // make sure we are subscribed
    let found = false
    const subs = await this.appSvc.getSubscriptions()
    subs.forEach(s => {
      if (s.exchange === algorithm.exchange) {
        found = s.pairs.includes(algorithm.pair)
      }
    })

    if (!found) {
      throw new HttpException(
        `${algorithm.exchange}:${algorithm.pair} does not have a running subscription`, 400
      )
    }

    await this.momentum.emit(
      `start:${algorithm.algorithm}:${algorithm.exchange}`,
      new AlgorithmEvent(
        algorithm.algorithm,
        algorithm.exchange,
        algorithm.pair,
        algorithm.size,
        algorithm.period,
        algorithm.lastTrade
      )
    )

    return {
      message: `Algorithm starting: ${JSON.stringify(algorithm)}`
    }
  }

  @Delete('/algorithms')
  async stopAlgo(@Body() algorithm: AlgorithmEvent) {
    await this.momentum.emit(`stop:${algorithm.algorithm}:${algorithm.exchange}`, algorithm)

    return {
      message: `Algorithm stopping: ${algorithm.algorithm}:${algorithm.exchange}:${algorithm.pair}`
    }
  }

  @Get('/trades')
  async getTrades() {
    const keys = await this.redis.keys('trades:*')
    return Promise.all(
      keys.map(async (k: string) => {
        const keys = k.split(':')
        const pair = keys[keys.length - 1]
        return {
          [pair]: await this.redis.lrange(k, 0, 100)
        }
      })
    )
  }

}
