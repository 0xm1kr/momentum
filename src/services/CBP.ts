import {
    CoinbasePro,
    Account,
    WebSocketEvent,
    WebSocketChannelName,
    OrderSide,
    WebSocketResponse,
    WebSocketTickerMessage,
    WebSocketChannel,
    WebSocketResponseType,
    OrderBookLevel2,
    OrderBookLevel,
    LimitOrder,
    MarketOrder,
    Order,
    OrderType,
    FeeUtil,
    FeeEstimate,
    CandleGranularity
} from 'coinbase-pro-node'
import { RBTree } from 'bintrees'
import ReconnectingWebSocket from 'reconnecting-websocket'
import bn from 'big.js'
import * as chalk from 'chalk'

import { logInfo, logDetail, logError } from '../utils/log'

//
// The CBPService handles  
// all interactions with  
// the Coinbase Pro API.
// 
// Built on top of:
// [coinbase-pro-node](https://github.com/bennyn/coinbase-pro-node)
//
// API Keys are needed for any secure 
// functionality and can be created here:
// https://pro.coinbase.com/profile/api
// https://public.sandbox.pro.coinbase.com/profile/api
//

export type CBPParams = {
    action: string
    product?: string
    param?: string
}

export type BookSnapshot = {
    type: WebSocketResponseType
    product_id: string
} & OrderBookLevel2

export type BookUpdate = {
    type: WebSocketResponseType
    product_id: string
    // [
    //     "buy|sell",  // buy/sell
    //     "11602.18",  // price level
    //     "0.00000000" // size: size of zero means this price level can be removed
    // ]
    changes: string[][]
}

export type CBPServiceParams = {

    auth: {
        apiKey: string
        apiSecret: string
        passphrase: string
        // https://docs.pro.coinbase.com/#sandbox
        useSandbox: boolean
    }
}

export class CBPService {

    protected client!: CoinbasePro
    protected connection: ReconnectingWebSocket
    protected channels: WebSocketChannel[] = []

    public bids: RBTree<string[]>
    public asks: RBTree<string[]>

    constructor(params: CBPServiceParams) {
        this.client = new CoinbasePro(params.auth)

        this.bids = new RBTree(
            (a, b) => (bn(a[0]).gt(bn(b[0])) ? 1 : (bn(a[0]).eq(bn(b[0])) ? 0 : -1))
        )
        this.asks = new RBTree(
            (a, b) => (bn(a[0]).gt(bn(b[0])) ? 1 : (bn(a[0]).eq(bn(b[0])) ? 0 : -1))
        )
    }

    /**
     * place a limit order
     * 
     * @param productId 
     * @param params {
     *  amount: amount in quote (e.g. USD)
     *  side: buy or sell
     * }
     */
    public async limitOrder(productId: string, params: {
        size: string
        side: OrderSide
        price: string
        stop?: 'loss' | 'entry'
        stopPrice?: string
    }): Promise<Order> {
        const o: LimitOrder = {
            type: OrderType.LIMIT,
            product_id: productId,
            side: params.side,
            size: params.size,
            price: params.price
        }

        // stop order
        if (params.stop) {
            o.stop = params.stop
            if (!params.stopPrice) throw new Error(`stopPrice is required for a stop ${params.stop} order`)
            o.stop_price = params.stopPrice
        }

        return this.client.rest.order.placeOrder(o)
    }

    /**
     * place a market order
     * 
     * @param productId 
     * @param params {
     *  amount: amount in quote (e.g. USD)
     *  side: buy or sell
     * }
     */
    public async marketOrder(productId: string, params: {
        amount: string
        side: OrderSide
    }): Promise<Order> {
        const o: MarketOrder = {
            type: OrderType.MARKET,
            product_id: productId,
            side: params.side,
            funds: params.amount
        }
        return this.client.rest.order.placeOrder(o)
    }

    /**
     * estimate an order fee
     * 
     * @param product 
     * @param params 
     */
    public async getFeeEstimate(product: string, params: {
        size: string
        price: string | number
        side: OrderSide
        type: OrderType
    }): Promise<FeeEstimate> {
        const pair = product.split('-')
        const quote = pair[1]
        const feeTier = await this.client.rest.fee.getCurrentFees()
        return FeeUtil.estimateFee(params.size, params.price, params.side, params.type, feeTier, quote)
    }

    /**
     * get accounts
     */
    public async getAccounts(): Promise<Account[]> {
        return this.client.rest.account.listAccounts()
    }

    /**
     * getBook
     * 
     * @param productId 
     */
    public async getBook(productId = 'BTC-USD'): Promise<OrderBookLevel2> {
        return this.client.rest.product.getProductOrderBook(productId, {
            level: OrderBookLevel.TOP_50_BIDS_AND_ASKS
        })
    }

    /**
     * subscribe to websocket channels
     * 
     * @param channels 
     * @param handler 
     */
    public subscribe(
        channels: WebSocketChannel[],
        handlers?: {
            message?: (message: WebSocketResponse) => unknown,
            ticker?: (message: WebSocketTickerMessage) => unknown
        }
    ): void {

        // message handler
        if (handlers.message) {
            this.client.ws.on(WebSocketEvent.ON_MESSAGE, handlers.message)
        }

        // ticker handler
        if (handlers.ticker) {
            this.client.ws.on(WebSocketEvent.ON_MESSAGE_TICKER, handlers.ticker)
        }

        // connection already open
        if (this.connection?.OPEN) {

            // subscribe
            this.channels = [
                ...channels,
                ...this.channels
            ]
            this.client.ws.subscribe(this.channels)

        } else {
            // on open, subscribe
            this.client.ws.on(WebSocketEvent.ON_OPEN, () => {
                this.client.ws.subscribe(channels)
            })

            // changes to subscriptions
            this.client.ws.on(WebSocketEvent.ON_SUBSCRIPTION_UPDATE, subscriptions => {
                // disconnect if no more subscriptions?
                if (subscriptions.channels.length === 0) {
                    this.client.ws.disconnect()
                }
            })

            // open connection
            this.connection = this.client.ws.connect({
                // debug: true
            })
        }
    }

    /**
     * Synchronize a product orderbook
     * TODO multiple products?
     * 
     * @param productId 
     */
    public syncBook(productId: string): void {
        // watch the book
        this.subscribe([{
            name: WebSocketChannelName.LEVEL2,
            product_ids: [productId],
        }], {
            message: (message) => {
                // handle snapshot
                if (message.type === WebSocketResponseType.LEVEL2_SNAPSHOT) {
                    for (let b = 0; b < (message as any).bids.length; b++) {
                        this.bids.insert((message as any).bids[b])
                    }
                    for (let a = 0; a < (message as any).asks.length; a++) {
                        this.asks.insert((message as any).asks[a])
                    }
                }

                // handle update
                if (message.type === WebSocketResponseType.LEVEL2_UPDATE) {
                    for (let c = 0; c < (message as any).changes.length; c++) {
                        const change = (message as any).changes[c]
                        if (change[0] === 'buy') {
                            const bid = this.bids.find([change[1], change[2]])
                            if (bid) {
                                if (bn(change[2]).eq(0)) {
                                    this.bids.remove([change[1], change[2]])
                                } else {
                                    this.bids.insert([change[1], change[2]])
                                }
                            } else {
                                this.bids.insert([change[1], change[2]])
                            }
                        }
                        if (change[0] === 'sell') {
                            const ask = this.asks.find([change[1], change[2]])
                            if (ask) {
                                if (bn(change[2]).eq(0)) {
                                    this.asks.remove([change[1], change[2]])
                                } else {
                                    this.asks.insert([change[1], change[2]])
                                }
                            } else {
                                this.asks.insert([change[1], change[2]])
                            }
                        }
                    }
                }
            }
        })
    }

    // -------- CLI Output Methods -------- //

    /**
     * list available accounts
     */
    public async viewBalances(): Promise<void> {
        const accounts = await this.getAccounts()
        const info = accounts.map(
            (a: Account) => `${a.currency.replace(',', '')}: ${chalk.green(a.available)}`
        )
        logInfo(`${chalk.white('Available Funds:')}\n----------------\n${info.join('\n')}`)
        logInfo('')
    }

    /**
     * estimate a products fees
     * 
     * @param productId 
     * @param size 
     * @param price 
     * @param side 
     */
    public async estimateFee(productId: string, size = '1', side = 'buy'): Promise<void> {
        const pair = productId.split('-')
        const base = pair[0]
        const quote = pair[1]

        // get current price
        const candles = await this.client.rest.product.getCandles(productId, {
            granularity: CandleGranularity.ONE_HOUR,
        })
        const lastPrice = candles[candles.length - 1].close

        // get fee
        const fee = await this.getFeeEstimate(productId, {
            size,
            price: lastPrice,
            side: (side as OrderSide),
            type: OrderType.MARKET
        })

        logInfo(chalk.white(`Buying "${size} ${base}" would cost around ${fee.effectiveTotal} ${quote} with a fee of ${chalk.red(`${fee.totalFee} ${quote}`)}.`))
        logInfo('')
    }

    /**
     * view book
     * 
     * @param productId
     */
    public async viewBook(productId = 'BTC-USD'): Promise<void> {
        const book = await this.getBook(productId)
        logInfo(`${chalk.white(`${productId} Order Book:`)}\n-------------------\n${JSON.stringify(book, null, 2)}`)
        logInfo('')
    }

    /**
     * buy some crypto
     * 
     * @param productId 
     * @param amount
     */
    public async purchase(productId = 'BTC-USD', amount: string): Promise<void> {
        try {
            const result = await this.marketOrder(productId, {
                amount, side: OrderSide.BUY
            })
            logInfo(`${chalk.green(`Purchased ${amount} ${productId}:`)}\n---------------------`)
            logDetail(JSON.stringify(result, null, 2))
            logInfo('')
        } catch (err) {
            logError(`${chalk.red(`Purchase of ${amount} ${productId} failed!`)}\n---------------------------------`)
            logDetail(JSON.stringify(err.response?.data, null, 2))
            logInfo('')
        }
    }

    /**
     * watch ticker
     * 
     * @param productId
     */
    public async watchTicker(productId = 'BTC-USD'): Promise<void> {
        this.subscribe([{
            name: WebSocketChannelName.TICKER,
            product_ids: [productId],
        }], {
            ticker(message) {
                const color = message.side === OrderSide.BUY ? chalk.green : chalk.red
                logInfo(color(`${productId}: ${message.side} ${message.last_size} @ ${message.price}`))
                logInfo('')
            }
        })
    }

    /**
     * watch book
     * 
     * @param productId
     */
    public async watchBook(productId = 'BTC-USD'): Promise<void> {

        // synchronize book
        this.syncBook(productId)

        // log book each second
        setInterval(() => {
            logInfo(chalk.green(this.bids.max()) + ' ' + chalk.red(this.asks.min()))
        }, 500)
    }


}
