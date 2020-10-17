import { Inject, Injectable } from '@nestjs/common'
import { ClientProxy } from '@nestjs/microservices'
import { filter, throttle } from 'rxjs/operators'
import bn from 'big.js'
import {
  CoinbaseService,
  CoinbaseSubscription
} from '@momentum/coinbase-client'
import { ClockEvent } from '@momentum/events/clock.event'
import { SubscriptionUpdateEvent } from '@momentum/events/subscription.event'
import {
  ClockService,
  ClockIntervalText,
  ClockInterval
} from '@momentum/clock'
import { Observable, interval } from 'rxjs'

export type Subscription = Observable<CoinbaseSubscription>
export type Subscriptions = Record<string, Subscription>
export type SupscriptionUpdates = Record<string, SubscriptionUpdateEvent[]>
export type SubscriptionUpdateTimes = Record<string, number[]>

@Injectable()
export class AppService {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly coinbaseSvc: CoinbaseService,
    private readonly clockSvc: ClockService
  ) { }
  
  private subscriptions: Subscriptions = {}
  private updateTimes: SubscriptionUpdateTimes = {}
  private updates: SupscriptionUpdates = {}

  async onApplicationBootstrap() {
    // connect to momentum pubsub
    await this.momentum.connect()
  }

  /**
   * Subscribe to pair
   * 
   * @param pair
   */
  async subscribe(pair: string): Promise<Subscription> {

    // subscribe to pair
    await this._subscribeToPair(pair)

    // start clocks if not already running
    if (!this.clockSvc.clocks?.[pair]) {
      Object.values(ClockIntervalText).forEach(
        (interval: ClockIntervalText) => this.clockSvc.start(interval, pair, this._clockEventHandler.bind(this))
      )
    }

    // save in memory and return
    return this.subscriptions[pair]
  }

  /**
   * Unsubscribe from pairs
   * 
   * @param pair 
   * @param exchange 
   */
  async unsubscribe(pair: string) {
    // unsubscribe
    await this.coinbaseSvc.unsubscribe(pair)

    if (!this.clockSvc.clocks?.[pair]) {
      Object.values(ClockIntervalText).forEach(
        (interval: ClockIntervalText) => this.clockSvc.stop(interval, pair)
      )
    }

    delete this.subscriptions[pair]
  }

  /**
   * Handle a clock event
   * 
   * @param exchange 
   * @param interval 
   * @param pair 
   */
  private _clockEventHandler(interval: ClockIntervalText, pair: string) {
    const now = new Date().getTime()
    const intvlTime = ClockInterval[interval]
    const lastIndex = this.updateTimes?.[pair]?.findIndex((t) => t < (now - intvlTime))
    const updates = this.updates?.[pair]?.slice(0, lastIndex)
    const totalTrades = updates?.reduce<number>((t, { lastTrade }) => lastTrade ? (t + 1) : t, 0)
    const priceSum = updates?.reduce<bn>((t, { lastTrade }) => bn(t).plus(lastTrade?.price || '0'), bn('0'))
    const sizeSum = updates?.reduce<bn>((t, { lastTrade }) => bn(t).plus(lastTrade?.size || '0'), bn('0'))
    const avgTradePrice = priceSum?.gt(0) ? priceSum.div(totalTrades)?.toString() : null
    const avgTradeSize = sizeSum?.gt(0) ? sizeSum.div(totalTrades)?.toString() : null

    // best bid/ask
    const bestAsk = this.updates?.[pair]?.[0]?.bestAsk
    const bestBid = this.updates?.[pair]?.[0]?.bestBid
    const lastTrade = this.updates?.[pair]?.[0]?.lastTrade
    
    // send event
    const ev = new ClockEvent(
      interval,
      'coinbase',
      pair,
      bestBid,
      bestAsk,
      avgTradePrice,
      avgTradeSize,
      // TODO liquidity calculations
      // TODO last trade information
    )

    // tell everyone what's up
    this.momentum.emit(`clock:${interval}:coinbase`, ev)

    // clear data each hour
    // TODO better way to do this?
    if (interval === '1m' && this.updates?.[pair]?.length) {
      const lastIndex = this.updateTimes?.[pair]?.findIndex((t) => t < (now - (3600 * 1000)))
      const updates = this.updates?.[pair]?.slice(0, lastIndex)
      if (updates.length) {
        this.updates[pair] = []
      }
    }
  }

  /**
   * Record a ticker price
   * 
   * @param exchange 
   * @param update 
   */
  private _recordUpdate(update: SubscriptionUpdateEvent) {
    const pair = update.pair

    // init
    if (typeof this.updates[pair] === 'undefined') {
      this.updates[pair] = []
      this.updateTimes[pair] = []
    }

    // unshift updates
    this.updates[pair].unshift(update)
    this.updateTimes[pair].unshift(new Date(update.timestamp).getTime())

    // emit update
    this.momentum.emit(`update:coinbase`, update)
  }

  /**
   * Subscribe to coinbase 
   * tickers and order books
   * 
   * @param pair
   */
  private async _subscribeToPair(pair: string): Promise<Observable<CoinbaseSubscription>> {
    return new Promise(async (res, rej) => {
      let resolved = false
      try {
        const subscription = await this.coinbaseSvc.subscribe(pair)
        subscription
          // .pipe(filter(sub => (sub.lastUpdateProperty !== 'book')))
          .pipe(throttle(() => interval(200)))
          .subscribe((sub) => {
            // console.log(sub)
            // setup handler
            this._handleSubscriptionUpdate(sub)
            // return once connected
            if (sub.connected && !resolved) {
              resolved = true
              res(subscription)
            }
          }, rej)
        } catch(err) {
          rej(err)
        }
    })
  }

  /**
   * Handle an update fired by a
   * coinbase subscription observable
   * 
   * @param update 
   */
  private _handleSubscriptionUpdate(update: CoinbaseSubscription) {
    const bestBid = update.book.bids.max()
    const bestAsk = update.book.asks.min()

    if (!bestBid || !bestAsk) return

    // check ticker update is unique
    const lastUpdate = this.updates[update.productId]?.[0]
    const changed = lastUpdate ? (String(lastUpdate?.lastTrade?.id) !== String(update.ticker?.trade_id)) : false
    const lastTrade = changed ? {
      id: String(update.ticker?.trade_id),
      price: update.ticker?.price,
      size: update.ticker?.last_size,
      timestamp: new Date(update.ticker?.time).getTime(), // unix
      side: update.ticker?.side
    } : null

    this._recordUpdate({
      pair: update.productId,
      property: update.lastUpdateProperty,
      timestamp: update.lastUpdate,
      lastTrade,
      bestBid,
      bestAsk,
      orders: update.orders
    })
  }
}
