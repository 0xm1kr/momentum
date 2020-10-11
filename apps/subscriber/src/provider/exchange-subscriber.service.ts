import { Inject, Injectable } from '@nestjs/common'
import { ClientProxy } from '@nestjs/microservices'
import { filter, throttle } from 'rxjs/operators'
import bn from 'big.js'
import {
  CoinbaseService,
  CoinbaseSubscription
} from '@momentum/coinbase-client'
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
} from './clock.service'
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

export type ExchangeSubscription = Observable<CoinbaseSubscription> // | Observable<AlpacaSubscription>
export type Subscription = Record<string, ExchangeSubscription>
export type ExchangeSubscriptions = Record<string, Subscription>

export type SupscriptionUpdates = Record<string, SubscriptionUpdateEvent[]>
export type ExchangeSubscriptionUpdates = Record<string, SupscriptionUpdates>

export type SubscriptionUpdateTimes = Record<string, number[]>
export type ExchangeSubscriptionUpdateTimes = Record<string, SubscriptionUpdateTimes>

@Injectable()
export class ExchangeSubscriberService {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly coinbaseSvc: CoinbaseService,
    private readonly alpacaSvc: AlpacaService,
    private readonly clockSvc: ClockService
  ) { }
  
  private exchanges: Record<any, Exchange> = {}  
  private subscriptions: ExchangeSubscriptions = {
    coinbase: {},
    alpaca: {}
  }
  private updateTimes: ExchangeSubscriptionUpdateTimes = {
    coinbase: {},
    alpaca: {}
  }
  private updates: ExchangeSubscriptionUpdates = {
    coinbase: {},
    alpaca: {}
  }

  async onApplicationBootstrap() {
    // connect to momentum pubsub
    await this.momentum.connect()

    // set exchanges
    this.exchanges = exchanges as any
  }

  /**
   * Subscribe to pair
   * 
   * @param subscriptions 
   * @param exchange 
   */
  async subscribe(pair: string, exchange = 'coinbase'): Promise<ExchangeSubscription> {
    if (typeof this.subscriptions[exchange] === 'undefined') {
      this.subscriptions[exchange] = {}
    }

    // subscribe to exchange
    switch (exchange) {
      case 'coinbase':
        await this._subscribeToCoinbasePair(pair)
        break;
      case 'alpaca':
        await this._subscribeToAlpacaPair(pair)
        break
      default:
        throw new Error('invalid exchange')
    }

    // start clocks if not already running
    if (!this.clockSvc.clocks?.[exchange]?.[pair]) {
      Object.values(ClockIntervalText).forEach(
        (i: ClockIntervalText) => this.clockSvc.start(
          exchange, i, pair, this._clockEventHandler.bind(this)
        )
      )
    }

    // save in memory and return
    return this.subscriptions[exchange][pair]
  }

  /**
   * Unsubscribe from pairs
   * 
   * @param pair 
   * @param exchange 
   */
  async unsubscribe(pair: string, exchange = 'coinbase') {
    switch (exchange) {
      case 'coinbase':
        await this.coinbaseSvc.unsubscribe(pair)
        break
      case 'alpaca':
        await this.alpacaSvc.unsubscribe(pair)
        break
      default:
        throw new Error('invalid exchange')
    }

    if (!this.clockSvc.clocks?.[exchange]?.[pair]) {
      Object.values(ClockIntervalText).forEach(
        (i: ClockIntervalText) => this.clockSvc.stop(exchange, i, pair)
      )
    }

    delete this.subscriptions[exchange][pair]
  }

  /**
   * Handle a clock event
   * 
   * @param exchange 
   * @param interval 
   * @param pair 
   */
  private _clockEventHandler(interval: ClockIntervalText, exchange: string, pair: string) {
    const now = new Date().getTime()
    const intvlTime = ClockInterval[interval]
    const lastIndex = this.updateTimes?.[exchange]?.[pair]?.findIndex((t) => t < (now - intvlTime))
    const updates = this.updates?.[exchange]?.[pair]?.slice(0, lastIndex)
    const totalTrades = updates?.reduce<number>((t, { lastTrade }) => lastTrade ? (t + 1) : t, 0)
    const priceSum = updates?.reduce<bn>((t, { lastTrade }) => bn(t).plus(lastTrade?.price || '0'), bn('0'))
    const sizeSum = updates?.reduce<bn>((t, { lastTrade }) => bn(t).plus(lastTrade?.size || '0'), bn('0'))
    const avgTradePrice = priceSum?.gt(0) ? priceSum.div(totalTrades)?.toString() : null
    const avgTradeSize = sizeSum?.gt(0) ? sizeSum.div(totalTrades)?.toString() : null

    // best bid/ask
    const bestAsk = this.updates?.[exchange]?.[pair]?.[0]?.bestAsk
    const bestBid = this.updates?.[exchange]?.[pair]?.[0]?.bestBid
    const lastTrade = this.updates?.[exchange]?.[pair]?.[0]?.lastTrade
    
    // send event
    const ev = new ClockEvent(
      interval,
      exchange,
      pair,
      bestBid,
      bestAsk,
      avgTradePrice,
      avgTradeSize,
      // TODO liquidity calculations
      // TODO last trade information
    )

    // tell everyone what's up
    this.momentum.emit(`clock:${interval}:${exchange}`, ev)

    // clear data each hour
    // TODO better way to do this?
    if (interval === '1m' && this.updates?.[exchange]?.[pair]?.length) {
      const lastIndex = this.updateTimes?.[exchange]?.[pair]?.findIndex((t) => t < (now - (3600 * 1000)))
      const updates = this.updates?.[exchange]?.[pair]?.slice(0, lastIndex)
      if (updates.length) {
        this.updates[exchange][pair] = []
      }
    }
  }

  /**
   * Record a ticker price
   * 
   * @param exchange 
   * @param update 
   */
  private _recordUpdate(exchange: string, update: SubscriptionUpdateEvent) {
    const pair = update.pair

    // init
    if (typeof this.updates[exchange][pair] === 'undefined') {
      this.updates[exchange][pair] = []
      this.updateTimes[exchange][pair] = []
    }

    // unshift updates
    this.updates[exchange][pair].unshift(update)
    this.updateTimes[exchange][pair].unshift(new Date(update.timestamp).getTime())

    // emit update
    this.momentum.emit(`update:${exchange}`, update)
  }

  /**
   * Subscribe to coinbase 
   * tickers and order books
   * 
   * @param pair
   */
  private async _subscribeToCoinbasePair(pair: string): Promise<Observable<CoinbaseSubscription>> {
    return new Promise(async (res, rej) => {
      let resolved = false
      try {
        const subscription = await this.coinbaseSvc.subscribe(pair)
        subscription
          // .pipe(filter(sub => (sub.lastUpdateProperty !== 'book')))
          .pipe(throttle(() => interval(100)))
          .subscribe((sub) => {
            // console.log(sub)
            // setup handler
            this._handleCoinbaseSubscriptionUpdate(sub)
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
  private _handleCoinbaseSubscriptionUpdate(update: CoinbaseSubscription) {
    const bestBid = update.book.bids.max()
    const bestAsk = update.book.asks.min()

    if (!bestBid || !bestAsk) return

    // check ticker update is unique
    const lastUpdate = this.updates['coinbase'][update.productId]?.[0]
    const changed = lastUpdate ? (String(lastUpdate?.lastTrade?.id) !== String(update.ticker?.trade_id)) : false
    const lastTrade = changed ? {
      id: String(update.ticker?.trade_id),
      price: update.ticker?.price,
      size: update.ticker?.last_size,
      timestamp: new Date(update.ticker?.time).getTime(), // unix
      side: update.ticker?.side
    } : null

    this._recordUpdate('coinbase', {
      pair: update.productId,
      property: update.lastUpdateProperty,
      timestamp: update.lastUpdate,
      lastTrade,
      bestBid,
      bestAsk,
      orders: update.orders
    })
  }

  /**
   * Subscribe to alpaca 
   * tickers and quotes
   * 
   * @param pairs 
   */
  private _subscribeToAlpacaPair(pair: string) {
    return new Promise(async (res, rej) => {
      let resolved = false
      try {
        // TODO more than USD?
        const symbol = pair.split('-')[0] 
        const subscription = await this.alpacaSvc.subscribe(symbol)

        // wait for subscription
        subscription
          // .pipe(filter(sub => (sub.lastUpdateProperty !== 'book')))
          .pipe(throttle(() => interval(100)))
          .subscribe((sub) => {
            // setup handler
            this._handleAlpacaSubscriptionUpdate(sub)
            // return subscription
            if (!resolved) {
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
   * alpaca subscription observable
   * 
   * @param update 
   */
  private _handleAlpacaSubscriptionUpdate(update: AlpacaSubscription) {
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
      exchange: this.exchanges[update.ticker?.x]?.code,
    } : null

    // record update
    this._recordUpdate('alpaca', {
      pair,
      property: update.lastUpdateProperty,
      timestamp: update.lastUpdate,
      lastTrade,
      bestBid: bestBid ? [bestBid.p, bestBid.s, bestBid.t, this.exchanges[bestBid.x]?.code] : null,
      bestAsk: bestAsk ? [bestAsk.p, bestAsk.s, bestAsk.t, this.exchanges[bestAsk.x]?.code] : null,
      orders: update.orders
    })
  }
}
