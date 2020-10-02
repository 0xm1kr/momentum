import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { RedisService } from 'nestjs-redis'
import { Redis } from 'ioredis';
import {
  CoinbaseService,
  WebSocketChannelName,
  WebSocketTickerMessage,
} from '@momentum/coinbase';

@Injectable()
export class ExchangeSubscriberService {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly redisSvc: RedisService,
    private readonly coinbaseSvc: CoinbaseService
  ) { }

  private redis: Redis

  async onApplicationBootstrap() {
    // connect to momentum pubsub
    await this.momentum.connect();

    // connect to store
    this.redis = await this.redisSvc.getClient('momentum')
  }

  /**
   * subscribe to books
   */
  async subscribe(cbSubs: string[]) {
    try {
      // get coinbase subscriptions
      if (cbSubs.length) {

        // Subscribe to tickers
        this.coinbaseSvc.subscribe({
          [WebSocketChannelName.TICKER]: cbSubs.map(s => ({
            productId: s,
            handler: (m: WebSocketTickerMessage) => {
               const productId = m.product_id
               this.redis.set(`coinbase:ticker:${productId}`, JSON.stringify(m))
 
               // TODO clock?
               this.momentum.emit(`coinbase:ticker`, m)
             }   
           }))
        })

        // sync book
        cbSubs.forEach((s: string) => {
          this.coinbaseSvc.syncBook(s, (product, bestBid, bestAsk) => {
            this.redis.set(`coinbase:best-bid:${product}`, bestBid[0])
            this.redis.set(`coinbase:best-ask:${product}`, bestAsk[0])
          })
        })
        
      }
    } catch(err) {
      console.log(err)
    }

  }

  /**
   * subscribe to books
   * 
   * TODO Coinbase vs Alpaca
   */
  async unsubscribe(cbSubs: string[]) {
    // get persisted subs
    if (cbSubs.length) {
      this.coinbaseSvc.unsubscribe({
        [WebSocketChannelName.TICKER]: cbSubs.map(s => ({
          productId: s
        })),
        [WebSocketChannelName.LEVEL2]: cbSubs.map(s => ({
          productId: s
        }))
      })
    }
  }
}
