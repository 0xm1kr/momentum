import { Injectable } from '@nestjs/common'
import { Observable, Observer } from 'rxjs'
import { RBTree } from 'bintrees'
import { AlpacaClient, AlpacaStream, PlaceOrder, Clock } from '@momentum/alpaca'

export type AlpacaClock = {
  isOpen: boolean,
  openTime: Date,
  closeTime: Date,
  currentTime: Date,
  timeToClose: number,
  timeToOpen: number
}

export type Granularity = '1Min' | '5Min' | '15Min' | '1D'

export type AlpacaSubscription = {
  symbol: string
  connected: string[]
  unsubscribe?: () => void
  quotes: any
  ticker?: any
  lastUpdate?: number // unix time
  lastUpdateProperty?: string // which property was updated
}

export type AlpacaSubscriptions = Record<string, Observable<AlpacaSubscription>>

@Injectable()
export class AlpacaService {

  protected _client!: AlpacaClient
  protected _stream!: AlpacaStream

  protected _heartbeatTimeout = 30000
  protected _connected = false
  protected _heartbeat!: NodeJS.Timeout
  protected _lastHeartBeat: number = null
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

  public get connection(): Promise<AlpacaStream> {
    if (this._connected) {
      return Promise.resolve(this._stream)
    }
    return this._connect()
  }

  public get clock(): Promise<Observable<AlpacaClock>> {
    if (this._observableClock) {
      return Promise.resolve(this._observableClock)
    }

    return this._getClock()
  }

  public get subscriptions() {
    return this._observableSubscriptions
  }

  /**
   * Get the Alpaca market clock
   */
  public async _getClock(): Promise<Observable<AlpacaClock>> {

    // setup
    const result = await this._client.getClock()
    let clock = await this._calculateClock(result)

    this._observableClock = new Observable(subject => {
      subject.next(clock)
      const intvl = setInterval(async () => {
        const result = await this._client.getClock()
        clock = this._calculateClock(result)
        subject.next(clock)
      }, 1000)
    })

    return this._observableClock
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
    this._observableSubscriptions[symbol] = await this._createSubscriptionObserver(symbol)

    // subscribe
    conn.subscribe([`T.${symbol}`, `Q.${symbol}`])

    return this._observableSubscriptions[symbol]
  }

  /**
  * Unsubscribe from a product
  * 
  * @param symbol 
  */
  public async unsubscribe(symbol: string) {
    if (!this._subscriptionMap?.[symbol]) return

    try {
      // unsubscribe
      this._subscriptionMap[symbol]?.unsubscribe()
      // remove data
      delete this._subscriptionMap[symbol]
      delete this._observableSubscriptions[symbol]
      delete this._observers[symbol]
    } catch (err) {
      console.warn(err)
    }

    return true
  }

  // ------- internal methods --------

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

    // init subscription
    this._subscriptionMap[symbol] = {
      symbol,
      connected: [],
      ticker: null,
      quotes: []
      // book: {
      //   bids: new RBTree(
      //     (a, b) => (bn(a[0]).gt(bn(b[0])) ? 1 : (bn(a[0]).eq(bn(b[0])) ? 0 : -1))
      //   ),
      //   asks: new RBTree(
      //     (a, b) => (bn(a[0]).gt(bn(b[0])) ? 1 : (bn(a[0]).eq(bn(b[0])) ? 0 : -1))
      //   )
      // }
    }

    // setup observable
    const subscription = new Observable<AlpacaSubscription>(subject => {
      this._observers[symbol] = subject

      // setup unsubscribe function
      // TODO what if this fails?
      this._subscriptionMap[symbol].unsubscribe = function unsubscribe() {
        conn.unsubscribe([`T.${symbol}`, `Q.${symbol}`])
        subject.complete()
      }
    })

    return subscription
  }

  /**
   * Handle initial auth
   * 
   * @param res
   */
  protected async _handleStreamAuth(res: (stream: AlpacaStream) => void) {
    console.log('Alpaca connection established')
    console.log('Active subscriptions:', Object.keys(this.subscriptions))

    // init heartbeat
    this._handleHeartBeat()

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
    console.log(message)

    this._handleHeartBeatMessage.bind(this)

    if ('stream' in message) {
      const subscriptions = message.data?.streams

      if (subscriptions && Object.keys(this._subscriptionMap)?.length)
        // set subscription connected flags
        for (const s of subscriptions) {
          const symbol = s.split('.')[1]
          if (!this._subscriptionMap[symbol].connected.includes(s)) {
            this._subscriptionMap[symbol].connected.push(s)
          }
          if (!this._observers[symbol]) {
            this._observableSubscriptions[symbol] = await this._createSubscriptionObserver(s)
          }
          this._observers[symbol].next(this._subscriptionMap[symbol])
        }
      // TODO handle unsubscribe?
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
    console.log(message)
    // const symbol = message.symbol

    // // event fired without initialized subscription?
    // if (!this._subscriptionMap?.[symbol]) return

    // this._subscriptionMap[symbol].ticker = message
    // this._subscriptionMap[symbol].lastUpdateProperty = 'ticker'
    // this._subscriptionMap[symbol].lastUpdate = new Date().getTime()
    // this._observers[symbol].next(this._subscriptionMap[symbol])
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
    console.log(message)
    // const symbol = (message as any).symbol

    // // event fired after unsubscribe
    // if (!this._subscriptionMap?.[symbol]) return

    // // handle update
    // if (message.type === WebSocketResponseType.LEVEL2_UPDATE) {

    //   for (let c = 0; c < (message as any).changes.length; c++) {
    //     const change = (message as any).changes[c]
    //     if (change[0] === 'buy') {
    //       const bid = this._subscriptionMap[symbol].book.bids.find([change[1], change[2]])
    //       if (bid) {
    //         if (bn(change[2]).eq(0)) {
    //           this._subscriptionMap[symbol].book.bids.remove([change[1], change[2]])
    //         } else {
    //           this._subscriptionMap[symbol].book.bids.insert([change[1], change[2]])
    //         }
    //       } else {
    //         this._subscriptionMap[symbol].book.bids.insert([change[1], change[2]])
    //       }
    //     }

    //     if (change[0] === 'sell') {
    //       const ask = this._subscriptionMap[symbol].book.asks.find([change[1], change[2]])
    //       if (ask) {
    //         if (bn(change[2]).eq(0)) {
    //           this._subscriptionMap[symbol].book.asks.remove([change[1], change[2]])
    //         } else {
    //           this._subscriptionMap[symbol].book.asks.insert([change[1], change[2]])
    //         }
    //       } else {
    //         this._subscriptionMap[symbol].book.asks.insert([change[1], change[2]])
    //       }
    //     }
    //   }

    //   this._subscriptionMap[symbol].lastUpdateProperty = 'book'
    //   this._subscriptionMap[symbol].lastUpdate = new Date().getTime()
    //   this._observers[symbol].next(this._subscriptionMap[symbol])
    // }
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
    if (activeSubs && this._heartbeat) {
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