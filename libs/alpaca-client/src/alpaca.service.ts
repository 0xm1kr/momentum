import { Injectable } from '@nestjs/common'
import { Subject } from 'rxjs'
import { takeWhile } from 'rxjs/operators'
import { RBTree } from 'bintrees'
import { 
  AlpacaClient, 
  AlpacaStream, 
  PlaceOrder, 
  Order, 
  Clock, 
  OrderSide, 
  OrderStatus 
} from '@momentum/alpaca'


export {
  PlaceOrder,
  Order,
  OrderSide,
  OrderStatus
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

export type AlpacaSubscriptions = Record<string, Subject<AlpacaSubscription>>

@Injectable()
export class AlpacaService {

  protected _client!: AlpacaClient
  // protected _client2!: AlpacaClient
  protected _dataStream!: AlpacaStream
  protected _accountStream!: AlpacaStream

  protected _heartbeatTimeout = 30000
  protected _clockCheckInterval = 30000
  protected _dataConnected = false
  protected _accountConnected = false
  protected _heartbeat!: NodeJS.Timeout
  protected _lastHeartBeat: number = null
  protected _clock!: AlpacaClock
  protected _observableClock: Subject<AlpacaClock>
  protected _subscriptionMap: Record<string, AlpacaSubscription> = {}
  protected _subscriptionObservers: Record<string, Subject<AlpacaSubscription>> = {}

  constructor() {
    this._client = new AlpacaClient({
      credentials: {
        // TODO configurable
        key: process.env.PAPER_ALPACA_KEY,
        secret: process.env.PAPER_ALPACA_SECRET
      },
      paper: true
      // rate_limit: true
    })
  }

  public get clock(): Promise<AlpacaClock> {
    if (this._observableClock) {
      return Promise.resolve(this._clock)
    }

    return this._initClock()
  }

  public get connection(): Promise<AlpacaStream> {
    if (this._dataConnected && this._accountConnected) {
      return Promise.resolve(this._dataStream)
    }

    return new Promise((res, rej) => {
      Promise.all([
        this._connectAccountStream(),
        this._connectDataStream()
      ])
        .then(() => res(this._dataStream))
        .catch((e) => rej(e))
    })
    
  }

  public get subscriptions() {
    return this._subscriptionObservers
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
    // HACK: can't use sandbox to get data...
    return this._client.getBars({
      timeframe: granularity,
      symbols: [symbol]
    })
  }

  /**
   * Get an order
   * 
   * @param orderId
   */
  public getOrder(orderId: string) {
    return this._client.getOrder({ order_id: orderId })
  }

  /**
   * Place a limit order
   * 
   * @param symbol 
   * @param params 
   */
  public async limitOrder(symbol: string, params: {
    size: number
    side: OrderSide
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
      // id?: string;
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

    // place order
    const placedOrder = await this._client.placeOrder(order)

    if (this._subscriptionMap[symbol]) {
      this._subscriptionMap[symbol].orders[placedOrder.id] = placedOrder
    }

    // TODO wait for order 
    // to fill or fail
    // return this.awaitOrder(placedOrder)

    return placedOrder
  }

   /**
   * Place a market order
   * 
   * @param symbol 
   * @param params 
   */
  public marketOrder(symbol: string, params: {
    size: number
    side: OrderSide
  }) {

    const order: PlaceOrder = {
      symbol,
      qty: params.size,
      side: params.side,
      type: 'market',
      time_in_force: 'fok'
    }

    return this._client.placeOrder(order)
  }

  /**
  * Subscribe to a symbol
  * 
  * @param symbol 
  */
  public async subscribe(symbol: string): Promise<Subject<AlpacaSubscription>> {
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
    })
    conn.unsubscribe(subs)

    // if markets are closed just resolve
    if (!this._clock?.isOpen) {
      return Promise.resolve(this._subscriptionObservers[symbol])
    }

    // wait for this subscription to become active
    return new Promise((res, rej) => {
      this._subscriptionObservers[symbol]
        .pipe(takeWhile(sub => (sub.connected.length !== 2), true))  
        .subscribe(sub => {
          if (sub.connected.length === 2) {
            res(this.subscriptions[symbol])
          }
        }, rej)
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

      // unsubscribe
      const subs = []
      Object.keys(this.subscriptions).forEach(s => {
        subs.push(`T.${s}`)
        subs.push(`Q.${s}`)
      })
      ;(await (this.connection)).unsubscribe(subs)

      // TODO await actual disconnect?
      
    } catch (err) {
      console.warn(err)
    }

    return true
  }

  /**
   * Check if an order is complete
   * 
   * @param order 
   */
  public orderComplete(order: Order) {
    return ['filled','canceled','expired','stopped','rejected','suspended'].includes(order?.status)
  }

  /**
   * Await an order
   * 
   * NOTE: only works when subscriber/runner
   * are in the same microservice.
   * 
   * @param order 
   */
  public async awaitOrder(order: Order): Promise<Order> {
    if (!this._subscriptionObservers[order.symbol]) {
      return Promise.reject(`Not subscribed to ${order.symbol}`)
    }
    
    return new Promise((res, rej) => {
      this._subscriptionObservers[order.symbol]
        .pipe(takeWhile(sub => (!this.orderComplete(sub.orders[order.id])), true))
        .subscribe(sub => {
          if (this.orderComplete(sub.orders[order.id])) {
            return res(sub.orders[order.id])
          }
      }, rej)
    })
  }

  // ------- internal methods --------

  /**
   * Get the Alpaca market clock
   */
  protected async _initClock(): Promise<AlpacaClock> {

    // setup
    const result = await this._client.getClock()
    
    // create observable
    this._observableClock = new Subject()
    this._clock = this._calculateClock(result)
    this._observableClock.next(this._clock)

    // TODO clear on error?
    const intvl = setInterval((async () => {
      const result = await this._client.getClock()
      this._clock = this._calculateClock(result)
      this._observableClock.next(this._clock)
    }).bind(this), this._clockCheckInterval)

    return this._clock
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
   * Connect to Alpaca Data stream Websocket(s)
   */
  protected async _connectDataStream(): Promise<AlpacaStream> {
    if (this._dataConnected) {
      return Promise.resolve(this._dataStream)
    }

    // connect to market data
    return new Promise((res, rej) => {

      // data stream
      this._dataStream = new AlpacaStream({
        credentials: {
          key: process.env.ALPACA_KEY,
          secret: process.env.ALPACA_SECRET
        },
        stream: 'market_data'
      })

      // on open
      this._dataStream.on('authenticated', this._handleStreamAuth.bind(this, res))

      // on error
      this._dataStream.on('error', (e) => {
        console.error(e)
        this._dataConnected = false
        rej(e)
      })

      // generic message
      this._dataStream.on('message', this._handleSubscriptionMessage.bind(this))

      // ticker message
      this._dataStream.on('trade', this._handleSubscriptionTradeMessage.bind(this))

      // quote update
      this._dataStream.on('quote', this._handleSubscriptionQuoteMessage.bind(this))
    })
  }

  /**
   * Connect to Alpaca Account Websocket
   */
  protected async _connectAccountStream(): Promise<AlpacaStream> {

    if (this._accountConnected) {
      return Promise.resolve(this._accountStream)
    }

    return new Promise((res, rej) => {
      
      // TODO account socket heartbeat?

      // init account stream
      this._accountStream = new AlpacaStream({
        credentials: {
          key: process.env.PAPER_ALPACA_KEY,
          secret: process.env.PAPER_ALPACA_SECRET
        },
        stream: 'account',
        paper: true
      })

      // wait for connection
      this._accountStream.on('message', (message: Record<string, any>) => {
        if ('stream' in message && message.data?.streams?.length) { 
          console.log('Alpaca account stream connected')
          this._accountConnected = true
          res(this._accountStream)
        }
      })

      // on error
      this._accountStream.on('error', (e) => {
        // TODO resolve if "already connected error"
        console.error('ALPACA ACCOUNT ERROR', e)
        this._accountConnected = false
        rej(e)
      })

      // handle order updates
      this._accountStream.on('trade_updates', this._handleOrderUpdates.bind(this))

      // on open
      this._accountStream.on('authenticated', () => {
        // subscribe to trade_updates
        this._accountStream.subscribe(['trade_updates'])
      })

    })
  }

  /**
   * Handle alpaca order updates
   * 
   * @param message 
   */
  protected async _handleOrderUpdates(message: Record<string, any>) {
    const symbol = message.order?.symbol
    
    // not listening to this book
    if (!symbol || !this._subscriptionMap[symbol]) return

    // new order Created
    if (message.event === 'new') {
      if (message.order && !this._subscriptionMap[symbol].orders[message.order.id]) {
        this._subscriptionMap[symbol].orders[message.order.id] = message.order     
        this._subscriptionMap[symbol].lastUpdateProperty = 'orders'
        this._subscriptionMap[symbol].lastUpdate = new Date().getTime()
        this._subscriptionObservers[symbol].next(this._subscriptionMap[symbol])
        console.log('ALPACA ORDER CREATED!', message.order)
      }
    }

    // updated order
    if ([
        'fill', 
        'partial_fill', 
        'canceled', 
        'expired', 
        'replaced', 
        'rejected', 
        'suspended'
      ].includes(message.event)) {

      // retrieve local instance of order
      const o = this._subscriptionMap[symbol].orders[message.order?.id]
      if (o) {
        // update local order with updated order
        this._subscriptionMap[symbol].orders[o.id] = message.order
        this._subscriptionMap[symbol].lastUpdateProperty = 'orders'
        this._subscriptionMap[symbol].lastUpdate = new Date().getTime()
        this._subscriptionObservers[symbol].next(this._subscriptionMap[symbol])
        console.log('ALPACA ORDER UPDATED!', message.order)
      }
    }
  }

  /**
   * Create a subscription observer
   * 
   * @param symbol 
   */
  protected async _createSubscriptionObserver(symbol: string): Promise<Subject<AlpacaSubscription>> {
    // connect
    const conn = await this.connection

    if (this._subscriptionObservers[symbol]) {
      return this._subscriptionObservers[symbol]
    }

    // setup observable
    this._subscriptionObservers[symbol] = new Subject<AlpacaSubscription>()

    // init subscription
    this._subscriptionMap[symbol] = {
      symbol,
      connected: [],
      ticker: null,
      quote: null,
      book: {
        bids: new RBTree((a, b) => (a.p > b.p) ? 1 : (a.p === b.p) ? 0 : -1),
        asks: new RBTree((a, b) => (a.p > b.p) ? 1 : (a.p === b.p) ? 0 : -1),
      },
      orders: {},
      unsubscribe: () => {
        this._subscriptionObservers[symbol].complete()
        delete this._subscriptionObservers[symbol]
        delete this._subscriptionMap[symbol]
      }
    }

    return this._subscriptionObservers[symbol]
  }

  /**
   * Handle initial auth
   * 
   * @param res
   */
  protected async _handleStreamAuth(res: (stream: AlpacaStream) => void) {
    console.log('Alpaca connection established')

    // init clock
    await this._initClock()
    
    this._observableClock.subscribe((c) => {
      if (!c.isOpen) {
        console.log(`Alpaca markets closed, markets re-open in ${Math.round(c?.timeToOpen)}min`)
      }
    })

    // init heartbeat
    this._handleHeartBeat()

    // resolve
    this._dataConnected = true
    res(this._dataStream)
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
      throw new Error(`Alpaca socket error ${message?.data?.error}`)
    }

    // heartbeat
    this._handleHeartBeatMessage()

    // handle subscription listeners
    if (message?.data) {
      if (message.stream == 'listening') {
        const subs = message?.data?.streams
        console.log('Alpaca active subscriptions', subs)
      }
    }

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
              if (!this._subscriptionObservers[symbol]) {
                await this._createSubscriptionObserver(symbol)
              }
              if (!this._subscriptionMap[symbol].connected.includes(s)) {
                this._subscriptionMap[symbol].connected.push(s)
              }
              this._subscriptionObservers[symbol].next(this._subscriptionMap[symbol])
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
    this._subscriptionObservers[symbol].next(this._subscriptionMap[symbol])
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

    // Clear out old/outdated quotes
    // TODO better way to handle this?   
    if (this._subscriptionMap[symbol].book.asks.size > 10) {
      const now = new Date().getTime()
      this._subscriptionMap[symbol].book.asks.each(a => {
        if (now - (a.t/1000000) > 1000) {
          this._subscriptionMap[symbol].book.asks.remove(a)
        }
      })
    }
    if (this._subscriptionMap[symbol].book.bids.size > 10) {
      const now = new Date().getTime()
      this._subscriptionMap[symbol].book.bids.each(b => {
        if (now - (b.t/1000000) > 1000) {
          this._subscriptionMap[symbol].book.bids.remove(b)
        }
      })
    }

    this._subscriptionMap[symbol].lastUpdateProperty = 'quote'
    this._subscriptionMap[symbol].lastUpdate = new Date().getTime()
    this._subscriptionObservers[symbol].next(this._subscriptionMap[symbol])
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
  protected _handleHeartBeat() {
    const activeSubs = Object.keys(this._subscriptionMap)?.length
    if (activeSubs && this._heartbeat && this._clock.isOpen) {
      const now = new Date().getTime()
      if ((now - this._lastHeartBeat) > this._heartbeatTimeout) {
        throw new Error('Alpaca heartbeat timed out!')
      }
      this._heartbeat = setTimeout(this._handleHeartBeat.bind(this), this._heartbeatTimeout)
    } else {
      this._heartbeat = setTimeout(this._handleHeartBeat.bind(this), this._heartbeatTimeout)
    }
  }

}