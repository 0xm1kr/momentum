import { Inject, Injectable } from '@nestjs/common'
import { ClientProxy } from '@nestjs/microservices'
import { filter, throttle } from 'rxjs/operators'
import bn from 'big.js'
import {
  AlpacaService,
  AlpacaSubscription
} from '@momentum/alpaca-client'
import { ClockEvent } from '@momentum/events/clock.event'
import { SubscriptionUpdateEvent, Trade } from '@momentum/events/subscription.event'
import {
  ClockService,
  ClockIntervalText,
  ClockInterval
} from '@momentum/clock'
import { Observable, interval } from 'rxjs'
import * as exchanges from './exchanges.json'

export type Exchange = {
  id: number
  type: string
  market: string
  mic: string
  name: string
  tape: string
  code?: string
}

export type Subscription = Observable<AlpacaSubscription>
export type Subscriptions = Record<string, Subscription>
export type SupscriptionUpdates = Record<string, SubscriptionUpdateEvent[]>
export type SubscriptionUpdateTimes = Record<string, number[]>

@Injectable()
export class AppService {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly alpacaSvc: AlpacaService,
    private readonly clockSvc: ClockService
  ) { }

  private exchanges: Record<any, Exchange> = {}
  private subscriptions: Subscriptions = {}
  private updateTimes: SubscriptionUpdateTimes = {}
  private updates: SupscriptionUpdates = {}

  async onApplicationBootstrap() {
    // connect to momentum pubsub
    await this.momentum.connect()

    // set exchanges from JSON
    // TODO retrieve from polygon.io?
    this.exchanges = exchanges as any
  }

  /**
   * Subscribe to pair
   * 
   * @param subscriptions 
   * @param exchange 
   */
  async subscribe(pair: string): Promise<Subscription> {

    // subscribe
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
   */
  async unsubscribe(pair: string) {
    await this.alpacaSvc.unsubscribe(pair)

    if (!this.clockSvc.clocks?.[pair]) {
      Object.values(ClockIntervalText).forEach(
        (interval: ClockIntervalText) => this.clockSvc.stop(interval, pair)
      )
    }

    delete this.subscriptions[pair]
  }

  // --------- internal methods -----------

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
      'alpaca',
      pair,
      bestBid,
      bestAsk,
      avgTradePrice,
      avgTradeSize,
      // TODO liquidity calculations
      // TODO additional last trade information
    )

    // tell everyone what's up
    this.momentum.emit(`clock:${interval}:alpaca`, ev)

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
   * Record a subscription update
   * 
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
    this.momentum.emit(`update:alpaca`, update)
  }

  /**
   * Subscribe to alpaca 
   * tickers and quotes
   * 
   * @param pairs 
   */
  private _subscribeToPair(pair: string) {
    return new Promise(async (res, rej) => {
      let resolved = false
      try {
        // TODO more than USD?
        const symbol = pair.split('-')[0]
        const subscription = await this.alpacaSvc.subscribe(symbol)

        // wait for subscription
        subscription
          // .pipe(filter(sub => (sub.lastUpdateProperty !== 'book')))
          .pipe(throttle(() => interval(200)))
          .subscribe((sub) => {
            // setup handler
            this._handleSubscriptionUpdate(sub)
            // return subscription
            if (!resolved) {
              resolved = true
              res(subscription)
            }
          }, rej)
      } catch (err) {
        rej(err)
      }
    })
  }

  /**
   * Handle an update fired by an
   * alpaca subscription observable
   * 
   * @param update 
   */
  private _handleSubscriptionUpdate(update: AlpacaSubscription) {
    // TODO bad bid/ask spread?
    const bestBid = update.book?.bids?.max()
    const bestAsk = update.book?.asks?.min()

    if (!bestBid || !bestAsk) return

    // check ticker update is unique
    // TODO more than USD?
    const pair = `${update.symbol}-USD`
    const lastUpdate = this.updates['alpaca'][pair]?.[0]
    const changed = lastUpdate ? (String(lastUpdate?.lastTrade?.id) !== String(update.ticker?.i)) : false
    const lastTrade: Trade = changed ? {
      id: String(update.ticker?.i),
      price: update.ticker?.p,
      size: update.ticker?.s,
      timestamp: (update.ticker?.t / 1000), // micro second
      flags: update.ticker?.c,
      exchange: this.exchanges[update.ticker?.x]?.name,
    } : null

    // record update
    this._recordUpdate({
      pair,
      property: update.lastUpdateProperty,
      timestamp: update.lastUpdate,
      lastTrade,
      bestBid: bestBid ? [bestBid.p, bestBid.s, bestBid.t, this.exchanges[bestBid.x]?.name] : null,
      bestAsk: bestAsk ? [bestAsk.p, bestAsk.s, bestAsk.t, this.exchanges[bestAsk.x]?.name] : null,
      orders: update.orders
    })
  }
}
