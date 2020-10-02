import { Controller } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';
import { RedisService } from 'nestjs-redis'
import { Redis } from 'ioredis';
import { ema } from 'moving-averages';
import { OrderSide } from 'coinbase-pro-node'
import bn from 'big.js'
import { AlgorithmStartEvent } from '@momentum/events';
import { CoinbaseService, WebSocketTickerMessage } from '@momentum/coinbase';

@Controller()
export class AppController {
    constructor(
        private readonly redisSvc: RedisService,
        private readonly cbService: CoinbaseService
    ) { }

    // TODO move all of this to a service
    private redis: Redis
    private prices: { [key: string]: number[] } = {}
    private pricePeriods = []
    private ema12 = []
    private ema26 = []
    private runInterval = null
    private productId = null
    private startTime = null
    private period = null
    private size = null

    async onApplicationBootstrap() {
        // connect to store
        this.redis = await this.redisSvc.getClient('momentum')
    }

    @EventPattern('stop:ema1226')
    async handleStop() {
        console.log('stopping', this.productId)
        clearInterval(this.runInterval)
        this.productId = null
        this.ema12 = []
        this.ema26 = []
        this.pricePeriods = []
    }

    @EventPattern('start:ema1226')
    async handleStart(data: AlgorithmStartEvent) {
        if (this.runInterval) {
            clearInterval(this.runInterval)
        }

        // TODO more than one product
        this.productId = data.productId
        this.period = data.period
        this.startTime = new Date().getTime()
        this.size = data.size
        console.log(`EMA 12 / 26: ${new Date(this.startTime).toISOString()}, period: ${this.period / 1000}`)

        // trading time
        let lastBuy: {
            size: string
            price: string
            time: number
        }
        let lastSell: {
            size: string
            price: string
            time: number
        }
        if (data.lastTrade) {
            const ps = data.lastTrade.split(',')
            if (ps[0] === 'buy') {
                lastBuy = {
                    size: this.size,
                    price: ps[1],
                    time: new Date().getTime()
                }
            }
            if (ps[0] === 'sell') {
                lastSell = {
                    size: this.size,
                    price: ps[1],
                    time: new Date().getTime()
                }
            }
        }
        console.log([lastBuy, lastSell])

        // backfill price data
        const candles = await this.cbService.getCandles(data.productId, data.period / 1000)
        this.pricePeriods = candles.map(c => (c.close))

        // run trade logic every second
        this.runInterval = setInterval(async () => {

            if (this.ema26.length) {
                const bestAsk = await this.redis.get(`coinbase:best-ask:${data.productId}`)
                const bestBid = await this.redis.get(`coinbase:best-bid:${data.productId}`)
                const ema12 = bn(this.ema12[this.ema12.length - 1])
                const ema26 = bn(this.ema26[this.ema26.length - 1])
                const ema12Slope = bn(this.ema12[this.ema12.length - 1]).minus(bn(this.ema12[this.ema12.length - 2]))
                const ema26Slope = bn(this.ema26[this.ema26.length - 1]).minus(bn(this.ema26[this.ema26.length - 2]))

                console.log('-------------------------')
                console.log(`best ask: ${bestAsk}`)
                console.log(`best bid: ${bestBid}`)
                console.log(`ema12 ${ema12}, ${ema12Slope}`)
                console.log(`ema26 ${ema26}, ${ema26Slope}`)
                console.log('-------------------------')

                // TODO auto calc available depth and fee

                // if the ema12 < ema26 
                // and the price is > last buy+fee
                // == short position (sell)
                if (bn(ema12).lt(ema26)
                    && ema12Slope.lt(0)
                    && ema26Slope.lt(0)
                    && !lastSell
                ) {
                    const lastBuyPrice = lastBuy?.price || 0
                    const lastTotal = bn(lastBuyPrice).plus((bn(lastBuyPrice).times(0.006)))
                    const curFee = bn(bestAsk[0]).times(0.001)
                    const reqPrice = lastTotal.plus(curFee)
                    console.log('required sell price:', reqPrice.toString())
                    if (!lastSell && (!lastBuy || reqPrice.lt(bestAsk[0]))) {
                        const order = {
                            size: this.size,
                            side: OrderSide.SELL,
                            price: bestAsk[0]
                        }
                        try {
                            // const o = await this.cbService.limitOrder(data.productId, order)
                            // console.log(o)
                            console.log(order)
                            lastSell = {
                                size: order.size,
                                price: order.price,
                                time: new Date().getTime()
                            }
                            lastBuy = null
                        } catch (err) {
                            console.log(err)
                        }
                    }
                }

                // if the ema12 > ema26
                // and the price is < last sell-fee
                // == long position (buy)
                if (bn(ema12).gt(ema26)
                    && ema12Slope.gt(0)
                    && ema26Slope.gt(0)
                    && !lastBuy
                ) {
                    const lastSellPrice = lastSell?.price || 0
                    const lastTotal = bn(lastSellPrice).minus((bn(lastSellPrice).times(0.006)))
                    const curFee = bn(bestBid[0]).times(0.001)
                    const reqPrice = lastTotal.minus(curFee)
                    console.log('required buy price', reqPrice.toString())
                    if (!lastBuy && (!lastSell || bn(reqPrice).gt(bestBid[0]))) {
                        const order = {
                            size: this.size,
                            side: OrderSide.BUY,
                            price: bestBid[0]
                        }
                        try {
                            // const o = await this.cbService.limitOrder(data.productId, order)
                            // console.log(o)
                            console.log(order)
                            lastBuy = {
                                size: order.size,
                                price: order.price,
                                time: new Date().getTime()
                            }
                            lastSell = null
                        } catch (err) {
                            console.log(err.response.data)
                        }
                    }
                }
            }

        }, 1000)
    }

    @EventPattern('coinbase:ticker')
    async handleCoinbaseTickerEvent(data: WebSocketTickerMessage) {
        const productId = data.product_id
        const price = data.price
        console.log('coinbase:ticker', productId, price, data.side)

        if (!this.prices[productId]) {
            this.prices[productId] = []
        }

        this.prices[productId].push(Number(price))
    }

    @EventPattern('alpaca:ticker')
    async handleAlpacaBookEvent(data: Record<string, unknown>) {
        console.log(data);
    }

    /**
     * calculate 1min 12/26 moving average
     * 
     * TODO configurable interval?
     */
    @EventPattern('interval:1m')
    async calc1mMovingAverage(): Promise<void> {
        console.log('interval:1m')
        if (!this.productId) return

        // --- calculate moving averages ---
        if (this.pricePeriods.length >= 26) {
            this.ema12 = ema(this.pricePeriods, 12)
            this.ema26 = ema(this.pricePeriods, 26)
        }

        // calculate periods
        const tPeriods = Math.round((new Date().getTime() - this.startTime) / this.period)
        console.log(`calculating period: ${tPeriods}`)

        // prices
        if (this.prices[this.productId].length) {
            this.pricePeriods.push(
                (this.prices[this.productId].reduce((sum, s) => {
                    return sum += (s || 0)
                }) / this.prices[this.productId].length)
            )
            // logInfo('Prices: ' + JSON.stringify(this.pricePeriods))
        }
        this.prices[this.productId] = []

        // calculate moving averages
        if (this.pricePeriods.length >= 26) {
            this.ema12 = ema(this.pricePeriods, 12)
            this.ema26 = ema(this.pricePeriods, 26)
            // shift one off
            this.pricePeriods.shift()
            this.redis.set(`algorithm:ema1226:12:${this.productId}`, JSON.stringify(this.ema12))
            this.redis.set(`algorithm:ema1226:26:${this.productId}`, JSON.stringify(this.ema26))
        }
    }
}
