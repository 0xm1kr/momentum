import { Injectable } from '@nestjs/common'
import { Observable, Observer } from 'rxjs'
import { AlpacaClient, AlpacaStream, PlaceOrder, Order, Clock } from '@momentum/alpaca'
import { RBTree } from 'bintrees'

export {
  PlaceOrder,
  Order
}

export type AlpacaClock = {
  isOpen: boolean,
  openTime: Date,
  closeTime: Date,
  currentTime: Date,
  timeToClose: number,
  timeToOpen: number
}

export type Granularity = '1Min' | '5Min' | '15Min' | '1D'

export type Book = {
  bids: Record<string, RBTree<string[]>>
  asks: Record<string, RBTree<string[]>>
}

export type AlpacaSubscription = {
  symbol: string
  connected: string[]
  unsubscribe?: () => void
  book?: Book
  quote?: any
  ticker?: any
  orders?: Record<string, Order>
  lastUpdate?: number // unix time
  lastUpdateProperty?: string // which property was updated
}

export type AlpacaSubscriptions = Record<string, Observable<AlpacaSubscription>>

@Injectable()
export class AlpacaService {

  protected _client!: AlpacaClient
  protected _stream!: AlpacaStream

  protected _heartbeatTimeout = 30000
  protected _clockCheckInterval = 30000
  protected _connected = false
  protected _heartbeat!: NodeJS.Timeout
  protected _lastHeartBeat: number = null
  protected _clock!: AlpacaClock
  protected _observableClock: Observable<AlpacaClock>
  protected _observableSubscriptions: AlpacaSubscriptions = {}
  protected _subscriptionMap: Record<string, AlpacaSubscription> = {}
  protected _observers: Record<string, Observer<AlpacaSubscription>> = {}

  constructor() {
    this._client = new AlpacaClient({
      credentials: {
        key: process.env.ALPACA_KEY,
        secret: process.env.ALPACA_SECRET
      },
      paper: true
      // rate_limit: true
    })
  }

  public get clock(): AlpacaClock {
    return this._clock
  }

  public get clock$(): Promise<Observable<AlpacaClock>> {
    if (this._observableClock) {
      return Promise.resolve(this._observableClock)
    }

    return this._initClock()
  }

  public get connection(): Promise<AlpacaStream> {
    if (this._connected) {
      return Promise.resolve(this._stream)
    }
    return this._connect()
  }

  public get subscriptions() {
    return this._observableSubscriptions
  }

  /**
   * Get current buying power
   */
  public async getBuyingPower() {
    const account = await this._client.getAccount()
    return account.buying_power
  }

  /**
   * Get stock bars
   * 
   * @param symbol 
   * @param granularity 
   */
  public getBars(symbol: string, granularity: Granularity) {
    return this._client.getBars({
      timeframe: granularity,
      symbols: [symbol]
    })
  }

  /**
   * Place a limit order
   * 
   * @param symbol 
   * @param params 
   */
  public limitOrder(symbol: string, params: {
    size: number
    side: 'buy' | 'sell'
    price: number
    stopPrice?: number
  }) {

    const order: PlaceOrder = {
      symbol,
      qty: params.size,
      side: params.side,
      type: 'limit',
      time_in_force: 'fok' // ?
      // extended_hours?: boolean;
      // client_order_id?: string;
      // trail_price?: number;
      // trail_percent?: number;
      // order_class?: 'simple' | 'bracket' | 'oco' | 'oto';
      // take_profit?: {
      //     limit_price: number;
      // };
    }

    if (params.stopPrice) {
      order.stop_loss = {
        stop_price: params.stopPrice,
        limit_price: params.price
      }
    } else {
      order.limit_price = params.price
    }

    return this._client.placeOrder(order)
  }


  /**
  * Subscribe to a symbol
  * 
  * @param symbol 
  */
  public async subscribe(symbol: string): Promise<Observable<AlpacaSubscription>> {
    // get connection
    const conn = await this.connection

    // resubscribe or refresh?
    if (this.subscriptions[symbol]) {
      return Promise.resolve(this.subscriptions[symbol])
    }

    // setup observer
    await this._createSubscriptionObserver(symbol)

    // unsubscribe but leave observables 
    // allowing conn to auto re-subscribe to all
    const subs = [`T.${symbol}`, `Q.${symbol}`]
    Object.keys(this.subscriptions).forEach(s => {
      subs.push(`T.${s}`)
      subs.push(`Q.${s}`)
      // TODO order updates
    })
    conn.unsubscribe(subs)

    // if markets are closed just resolve
    if (!this.clock?.isOpen) {
      return Promise.resolve(this._observableSubscriptions[symbol])
    }

    // wait for this subscription to become active
    return new Promise((res, rej) => {
      this._observableSubscriptions[symbol].subscribe(o => {
        if (o.connected) {
          res(this._observableSubscriptions[symbol])
        }
      })
    })
  }

  /**
  * Unsubscribe from a product
  * 
  * @param symbol 
  */
  public async unsubscribe(symbol: string) {
    if (!this._subscriptionMap[symbol]) return

    try {
      // unsubscribe (complete observable)
      this._subscriptionMap[symbol]?.unsubscribe()

      // remove data
      delete this._subscriptionMap[symbol]
      delete this._observableSubscriptions[symbol]
      delete this._observers[symbol]

      // unsubscribe to
      // trigger auto-rescribe
      const subs = []
      Object.keys(this.subscriptions).forEach(s => {
        subs.push(`T.${s}`)
        subs.push(`Q.${s}`)
      })
      ;(await (this.connection)).unsubscribe(subs)

      // TODO await actual disconnect message?
      
    } catch (err) {
      console.warn(err)
    }

    return true
  }

  // ------- internal methods --------

  /**
   * Get the Alpaca market clock
   */
  protected async _initClock(): Promise<Observable<AlpacaClock>> {

    // setup
    const result = await this._client.getClock()
    this._clock = this._calculateClock(result)

    // create observable
    this._observableClock = new Observable(subject => {
      subject.next(this._clock)
      // TODO clear on error?
      const intvl = setInterval((async () => {
        const result = await this._client.getClock()
        this._clock = this._calculateClock(result)
        subject.next(this._clock)
      }).bind(this), this._clockCheckInterval)
    })

    return this._observableClock
  }

  /**
   * Calculate Alpaca clock info
   * 
   * @param clock 
   */
  protected _calculateClock(clock: Clock): AlpacaClock {
    const now = clock.timestamp.getTime()
    const open = clock.next_open.getTime()
    const close = clock.next_close.getTime()
    const timeToOpen = (open - now) / 60 / 1000
    const timeToClose = (close - now) / 60 / 1000

    return {
      isOpen: clock.is_open,
      currentTime: clock.timestamp,
      closeTime: clock.next_close,
      openTime: clock.next_open,
      timeToOpen,
      timeToClose
    }
  }

  /**
   * Connect to Coinbase Websocket
   */
  protected async _connect(): Promise<AlpacaStream> {

    return new Promise((res, rej) => {

      // connect
      this._stream = new AlpacaStream({
        credentials: {
          key: process.env.ALPACA_KEY,
          secret: process.env.ALPACA_SECRET
        },
        stream: 'market_data'
      })

      // on open
      this._stream.on('authenticated', this._handleStreamAuth.bind(this, res))

      // on error
      this._stream.on('error', (e) => {
        console.error(e)
        this._connected = false
        rej(e)
      })

      // generic message
      this._stream.on('message', this._handleSubscriptionMessage.bind(this))

      // ticker message
      this._stream.on('trade', this._handleSubscriptionTradeMessage.bind(this))

      // quote update
      this._stream.on('quote', this._handleSubscriptionQuoteMessage.bind(this)
      )
    })
  }

  /**
   * Create a subscription observer
   * 
   * @param symbol 
   */
  protected async _createSubscriptionObserver(symbol: string): Promise<Observable<AlpacaSubscription>> {
    // connect
    const conn = await this.connection

    if (this._observableSubscriptions[symbol]) {
      return this._observableSubscriptions[symbol]
    }

    // init subscription
    this._subscriptionMap[symbol] = {
      symbol,
      connected: [],
      ticker: null,
      quote: null,
      book: {
        bids: new RBTree((a, b) => (a.t - b.t || a.p - b.p)),
        asks: new RBTree((a, b) => (a.t - b.t || a.p - b.p))
      }
    }

    // setup observable
    this._observableSubscriptions[symbol] = new Observable<AlpacaSubscription>(subject => {
      this._observers[symbol] = subject

      // setup unsubscribe function
      // TODO what if this fails?
      this._subscriptionMap[symbol].unsubscribe = function unsubscribe() {
        subject.complete()
      }
    })

    return this._observableSubscriptions[symbol]
  }

  /**
   * Handle initial auth
   * 
   * @param res
   */
  protected async _handleStreamAuth(res: (stream: AlpacaStream) => void) {
    console.log('Alpaca connection established')

    // init clock
    const clock = await this._initClock()
    clock.subscribe((c) => {
      if (!c.isOpen) {
        console.log(`Alpaca markets closed, markets re-open in ${Math.round(c?.timeToOpen)}min`)
      }
    })

    // init heartbeat
    this._initHeartBeat()

    // resolve
    this._connected = true
    res(this._stream)
  }

  /**
   * Handle general socket messages
   * 
   * @param message 
   */
  protected async _handleSubscriptionMessage(
    message: Record<string, any>
  ) {
    // handle error
    if (message?.data?.error) {
      console.error(`Alpaca socket error ${message?.data?.error}`)
      return
    }

    // handle subscription listeners
    if (message?.data) {
      if (message.stream == 'listening') {
        const subs = message?.data?.streams
        console.log('Alpaca active subscriptions', subs)
      }
    }

    // set up heart beat
    this._handleHeartBeatMessage.call(this)

    if ('stream' in message) {
      // syncronize local subs and connected subs
      const subscriptions = message.data.streams
      if (Object.keys(this._subscriptionMap)?.length) {

        // connect
        if (subscriptions && !subscriptions.length) {
          const subs = []
          Object.keys(this.subscriptions).forEach(s => {
            subs.push(`T.${s}`)
            subs.push(`Q.${s}`)
          })
          ;(await this.connection).subscribe(subs)
        } 
        // setup subscribers
        else {
          if (subscriptions) {
            for (const s of subscriptions) {
              const symbol = s.split('.')[1]
              if (!this._observers[symbol]) {
                await this._createSubscriptionObserver(symbol)
              }
              if (!this._subscriptionMap[symbol].connected.includes(s)) {
                this._subscriptionMap[symbol].connected.push(s)
              }
              this._observers[symbol].next(this._subscriptionMap[symbol])
            }
            console.log('Alpaca active subscriptions', subscriptions)
          }
        }
      }
    }
  }

  /**
   * Handle a subscription ticker message
   * 
   * @param subject 
   * @param message 
   */
  protected _handleSubscriptionTradeMessage(
    message: Record<string, any>
  ) {
    const symbol = message.T

    // event fired without initialized subscription?
    if (!this._subscriptionMap?.[symbol]) return

    this._subscriptionMap[symbol].ticker = message
    this._subscriptionMap[symbol].lastUpdateProperty = 'ticker'
    this._subscriptionMap[symbol].lastUpdate = new Date().getTime()
    this._observers[symbol].next(this._subscriptionMap[symbol])
  }

  /**
   * Handle a quote update
   * 
   * @param subject 
   * @param message 
   */
  protected _handleSubscriptionQuoteMessage(
    message: Record<string, any>
  ) {
    const symbol = message.T

    // event fired without initialized subscription?
    if (!this._subscriptionMap?.[symbol]) return

    this._subscriptionMap[symbol].quote = message

    // Clear out old/outdated quotes
    // TODO better way to handle this would
    // ideally be to store bid/asks as a unique
    // by exchange code sorted by price list
    if (this._subscriptionMap[symbol].book.asks.size > 10) {
      this._subscriptionMap[symbol].book.bids.clear()
      this._subscriptionMap[symbol].book.asks.clear()
    }
    
    const bid = {
      p: message.p,
      s: message.s,
      t: message.t,
      x: message.x
    }
    const ask = {
      p: message.P,
      s: message.S,
      t: message.t,
      x: message.X
    }
    this._subscriptionMap[symbol].book.bids.insert(bid)
    this._subscriptionMap[symbol].book.asks.insert(ask)
    this._subscriptionMap[symbol].lastUpdateProperty = 'quote'
    this._subscriptionMap[symbol].lastUpdate = new Date().getTime()
    this._observers[symbol].next(this._subscriptionMap[symbol])
  }

  /**
   * Set last message date
   */
  protected _handleHeartBeatMessage() {
    this._lastHeartBeat = new Date().getTime()
  }

  /**
   * handle heartbeat logic
   */
  protected _initHeartBeat() {
    const activeSubs = Object.keys(this._subscriptionMap)?.length
    if (activeSubs && this._heartbeat && this._clock?.isOpen) {
      const now = new Date().getTime()
      if ((now - this._lastHeartBeat) > this._heartbeatTimeout) {
        throw new Error('Alpaca heartbeat timed out!')
      }
    }
    this._heartbeat = setTimeout(this._initHeartBeat.bind(this), this._heartbeatTimeout)
  }

}