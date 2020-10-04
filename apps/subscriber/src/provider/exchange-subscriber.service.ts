import { Inject, Injectable } from '@nestjs/common'
import { ClientProxy } from '@nestjs/microservices'
import bn from 'big.js'
import {
  Observable,
  CoinbaseService,
  CoinbaseSubscriptions,
  WebSocketChannelName,
  WebSocketTickerMessage
} from '@momentum/coinbase'
import { ClockEvent } from '@momentum/events/clock.event'
import { 
  ClockService, 
  ClockIntervalText, 
  ClockInterval
} from './clock.service'

type Tickers = WebSocketTickerMessage[] // | AlpacaTickerMessage
type PairTickers = Record<string, Tickers>
type ExchangeTickers = Record<string, PairTickers>

type TickerTimes = number[]
type PairTickerTimes = Record<string, TickerTimes>
type ExchangeTickerTimes = Record<string, PairTickerTimes>

@Injectable()
export class ExchangeSubscriberService {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly coinbaseSvc: CoinbaseService,
    private readonly clockSvc: ClockService
  ) { }
  
  private cbSubscriptions: Observable<CoinbaseSubscriptions>
  private tickers: ExchangeTickers = {}
  private tickerTimes: ExchangeTickerTimes = {}

  async onApplicationBootstrap() {
    // connect to momentum pubsub
    await this.momentum.connect();

    // listen to coinbase subscriptions
    this.cbSubscriptions = await this.coinbaseSvc.subscriptions
    this.cbSubscriptions.subscribe(console.log, console.error)

    // listen to alpaca subscriptions
    // TODO
  }

  /**
   * Subscribe to pairs
   * 
   * @param subscriptions 
   * @param exchange 
   */
  async subscribe(subscriptions: string[], exchange = 'coinbase') {
    // get subscriptions
    if (!subscriptions.length) {
      throw new Error('at least one pair is required to subscribe')
    }

    switch (exchange) {
      case 'coinbase':
        this._subscribeToCoinbasePairs(subscriptions)
        break
      case 'alpaca':
        // TODO
        break
      default:
        throw new Error('invalid exchange')
    }
  }

  /**
   * Unsubscribe from pairs
   * 
   * @param subscriptions 
   * @param exchange 
   */
  async unsubscribe(subscriptions: string[], exchange = 'coinbase') {
    // get coinbase subscriptions
    if (!subscriptions.length) {
      throw new Error('at least one pair is required to unsubscribe')
    }

    switch (exchange) {
      case 'coinbase':
        this._unsubscribeFromCoinbasePairs(subscriptions)
        break
      case 'alpaca':
        // TODO
        break
      default:
        throw new Error('invalid exchange')
    }
  }

  /**
   * Handle a clock event
   * 
   * @param exchange 
   * @param interval 
   * @param pair 
   */
  private _clockEventHandler(interval: ClockIntervalText, exchange: string,  pair: string) {

    const now = new Date().getTime()
    const intvlTime = ClockInterval[interval]
    const lastIndex = this.tickerTimes?.[exchange]?.[pair]?.findIndex((t) => t < (now-intvlTime))

    // TODO cb vs. alpaca tickers
    const tickers = this.tickers?.[exchange]?.[pair]?.slice(0, lastIndex)
    const priceSum = tickers?.reduce<bn>((t, {price}) => bn(t).plus(price), bn('0'))

    const avgTradePrice = priceSum?.gt(0) ? priceSum.div(tickers.length)?.toString() : null

    const ev = new ClockEvent(
      interval,
      exchange,
      pair,
      this.coinbaseSvc.getBestBid(pair),
      this.coinbaseSvc.getBestAsk(pair),
      avgTradePrice
    )

    // tell everyone what's up
    this.momentum.emit(`clock:${interval}`, ev)

    // clear data 
    // TODO max inteerval
    if (interval === '15m' && this.tickers?.[exchange]?.[pair].length) {
      this.tickers[exchange][pair] = []
    }
  }

  /**
   * Record a ticker price
   * 
   * @param exchange 
   * @param m 
   */
  private _recordTicker(exchange: string, m: WebSocketTickerMessage) {
    const pair = m.product_id

    // init
    if (typeof this.tickers[exchange] === 'undefined') {
        this.tickers[exchange] = {}
        this.tickerTimes[exchange] = {}
    }
    if (typeof this.tickers[exchange][pair] === 'undefined') {
        this.tickers[exchange][pair] = []
        this.tickerTimes[exchange][pair] = []
    }

    // push
    this.tickers[exchange][pair].unshift(m)
    this.tickerTimes[exchange][pair].unshift(new Date(m.time).getTime())
  }

   /**
   * Subscribe to coinbase 
   * tickers and order books
   * 
   * @param pairs 
   */
  private _subscribeToCoinbasePairs(pairs: string[]) {

    if (!this.cbSubscriptions) {

    }
    
    // Subscribe to tickers
    this.coinbaseSvc.subscribe({
      [WebSocketChannelName.TICKER]: pairs.map(s => ({
        productId: s,
        handler: (m: WebSocketTickerMessage) => {
          this._recordTicker('coinbase', m)
          this.momentum.emit(`ticker:coinbase:${m.product_id}`, m)
        }
      }))
    })
    
    
    // Start syncing books
    pairs.forEach((s: string) => {
      this.coinbaseSvc.syncBook(s)
    })

    // Start clocks
    pairs.forEach((p: string) => {
      Object.values(ClockIntervalText).forEach(
        (i: ClockIntervalText) => this.clockSvc.start(
          'coinbase', i, p, this._clockEventHandler.bind(this)
        )
      )
    })
  }

  /**
   * Unsubscribe from coinbase 
   * tickers and order books
   * 
   * @param pairs 
   */
  private _unsubscribeFromCoinbasePairs(pairs: string[]) {
    if (pairs.length) {

      // Stop clocks
      pairs.forEach((p: string) => {
        Object.values(ClockIntervalText).forEach(
          (i: ClockIntervalText) => this.clockSvc.stop('coinbase', i, p)
        )
      })

      // Unsubscribe
      this.coinbaseSvc.unsubscribe({
        [WebSocketChannelName.TICKER]: pairs.map(s => ({
          productId: s
        })),
        [WebSocketChannelName.LEVEL2]: pairs.map(s => ({
          productId: s
        }))
      })
    }
  }

  /**
   * Subscribe to alpaca 
   * tickers and quotes
   * 
   * @param pairs 
   */
  private _subscribeToAlpacaPairs(pairs: string[]) {
    // TODO
  }

  /**
   * Unsubscribe from alpaca 
   * tickers and quotes
   * 
   * @param pairs 
   */
  private _unsubscribeFromAlpacaPairs(pairs: string[]) {
    // TODO
  }

}
