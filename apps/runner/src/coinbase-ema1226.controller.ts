import { Controller, Inject } from '@nestjs/common'
import { ClientProxy, EventPattern } from '@nestjs/microservices'
import { RedisService } from 'nestjs-redis'
import { Redis } from 'ioredis'
import { ema } from 'moving-averages'
import { OrderSide } from 'coinbase-pro-node'
import bn from 'big.js'
import { AlgorithmEvent, ClockEvent, ClockInterval, ClockIntervalText } from '@momentum/events'
import { CoinbaseService } from '@momentum/coinbase'

type Trade = {
    side: string
    size: string
    price: string
    time: number
}

export type AlgorithmData = {
    pair: string
    startTime: number
    period: ClockIntervalText
    pricePeriods: number[]
    ema12: number[]
    ema26: number[]
    size: string
    lastBuy?: Trade
    lastSell?: Trade
}

export type ActivePairs = Record<string, AlgorithmData>

@Controller()
export class CoinbaseEMA1226Controller {
    constructor(
        @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
        private readonly redisSvc: RedisService,
        private readonly cbService: CoinbaseService
    ) { }

    // TODO move all of this to a service
    private redis: Redis
    private activePairs: ActivePairs = {}

    async onApplicationBootstrap() {
        // connect to store
        this.redis = await this.redisSvc.getClient('momentum-state')

        // check for running algos
        const algos = await this.redis.keys('algorithms:ema1226:coinbase:*')
        if (algos.length) {
            for (const a of algos) {
                const params = await this.redis.hgetall(a) as unknown
                const lastTrade = await this.redis.rpop(`trades:coinbase:${(params as AlgorithmEvent).pair}`)
                this._start({
                    ...params as AlgorithmEvent,
                    lastTrade
                })
            }
        }
    }

    @EventPattern('update:coinbase')
    async handleOneSec(data: ClockEvent) {
        if (!this.activePairs[data.pair]) return

        if (this.activePairs[data.pair].ema26.length) {
            const bestAsk = data.bestAsk[0]
            const bestBid = data.bestBid[0]
            const ema12 = bn(this.activePairs[data.pair].ema12[this.activePairs[data.pair].ema12.length - 1])
            const ema26 = bn(this.activePairs[data.pair].ema26[this.activePairs[data.pair].ema26.length - 1])
            const ema12Slope = bn(this.activePairs[data.pair].ema12[this.activePairs[data.pair].ema12.length - 1])
                .minus(bn(this.activePairs[data.pair].ema12[this.activePairs[data.pair].ema12.length - 2]))
            const ema26Slope = bn(this.activePairs[data.pair].ema26[this.activePairs[data.pair].ema26.length - 1])
                .minus(bn(this.activePairs[data.pair].ema26[this.activePairs[data.pair].ema26.length - 2]))

            console.log('-------------------------')
            console.log(`bestAsk ${data.bestAsk}`)
            console.log(`bestBid ${data.bestBid}`)
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
                && !this.activePairs[data.pair].lastSell
            ) {
                const lastBuyPrice = this.activePairs[data.pair].lastBuy?.price || 0
                const lastTotal = bn(lastBuyPrice).plus((bn(lastBuyPrice).times(0.006)))
                const curFee = bn(bestAsk[0]).times(0.001)
                const reqPrice = lastTotal.plus(curFee)
                console.log('required sell price:', reqPrice.toString())
                if (!this.activePairs[data.pair].lastSell && (!this.activePairs[data.pair].lastBuy || reqPrice.lt(bestAsk[0]))) {
                    const order = {
                        pair: data.pair,
                        size: this.activePairs[data.pair].size,
                        side: OrderSide.SELL,
                        price: bestAsk[0],
                        time: new Date().getTime()
                    }
                    try {
                        // const o = await this.cbService.limitOrder(data.pair, order)
                        this.momentum.emit('trade:coinbase', order)
                        this.activePairs[data.pair].lastSell = {
                            side: 'sell',
                            size: order.size,
                            price: order.price,
                            time: order.time
                        }
                        this.redis.rpush(`trades:coinbase:${data.pair}`, `sell,${order.price},${order.time}`)
                        this.activePairs[data.pair].lastBuy = null
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
                && !this.activePairs[data.pair].lastBuy
            ) {
                const lastSellPrice = this.activePairs[data.pair].lastSell?.price || 0
                const lastTotal = bn(lastSellPrice).minus((bn(lastSellPrice).times(0.006)))
                const curFee = bn(bestBid[0]).times(0.001)
                const reqPrice = lastTotal.minus(curFee)
                console.log('required buy price', reqPrice.toString())
                if (!this.activePairs[data.pair].lastBuy && (!this.activePairs[data.pair].lastSell || bn(reqPrice).gt(bestBid[0]))) {
                    const order = {
                        pair: data.pair,
                        size: this.activePairs[data.pair].size,
                        side: OrderSide.BUY,
                        price: bestBid[0],
                        time: new Date().getTime()
                    }
                    try {
                        // const o = await this.activePairs[data.pair].cbService.limitOrder(data.pair, order)
                        // console.log(o)
                        this.momentum.emit('trade:coinbase', order)
                        this.activePairs[data.pair].lastBuy = {
                            side: 'buy',
                            size: order.size,
                            price: order.price,
                            time: order.time
                        }
                        this.redis.rpush(`trades:coinbase:${data.pair}`, `buy,${order.price},${order.time}`)
                        this.activePairs[data.pair].lastSell = null
                    } catch (err) {
                        console.log(err.response.data)
                    }
                }
            }
        }
    }

    /**
     * calculate 1min 12/26 moving average
     */
    @EventPattern('clock:1m:coinbase')
    async handleOneMin(data: ClockEvent): Promise<void> {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period === '1m') {
            this._calcMovingAvg(data, ClockIntervalText.OneMinute)
        }
    }

    /**
     * calculate 5min 12/26 moving average
     */
    @EventPattern('clock:5m:coinbase')
    async handleFiveMin(data: ClockEvent): Promise<void> {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period === '5m') {
            this._calcMovingAvg(data, ClockIntervalText.FiveMinute)
        }
    }

    /**
     * calculate 15min 12/26 moving average
     */
    @EventPattern('clock:15m:coinbase')
    async handleFifteenMin(data: ClockEvent): Promise<void> {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period === '15m') {
            this._calcMovingAvg(data, ClockIntervalText.FifteenMinute)
        }
    }

    @EventPattern('stop:ema1226:coinbase')
    async handleStop(data: AlgorithmEvent) {
        console.log('stopping', data.pair)
        delete this.activePairs[data.pair]
        await this.redis.del(`algorithms:ema1226:coinbase:${data.pair}`)
    }

    @EventPattern('start:ema1226:coinbase')
    async handleStart(data: AlgorithmEvent) {
        await this._start(data)
    }

    /**
     * Start running an algo
     * 
     * @param data 
     */
    private async _start(data: AlgorithmEvent) {
        const startTime = new Date()

        // set active
        this.activePairs[data.pair] = {
            pair: data.pair,
            startTime: startTime.getTime(),
            period: data.period,
            size: data.size,
            // TODO last trade?
            lastBuy: null,
            lastSell: null,
            pricePeriods: [],
            ema12: [],
            ema26: [],
        }

        // previous trades
        if (data.lastTrade) {
            const lt = data.lastTrade.split(',')
            if (lt[0] === 'buy') {
                this.activePairs[data.pair].lastBuy = {
                    side: 'buy',
                    size: data.size,
                    price: lt[1],
                    time: Number(lt[2]) || new Date().getTime()
                }
            }
            if (lt[0] === 'sell') {
                this.activePairs[data.pair].lastSell = {
                    side: 'sell',
                    size: data.size,
                    price: lt[1],
                    time: Number(lt[2]) || new Date().getTime()
                }
            }
        }

        // log info
        console.log(`STARTING: EMA 12 / 26: ${startTime.toISOString()}`, JSON.stringify(this.activePairs[data.pair], null, 2))

        // backfill price data
        const period = ClockInterval[data.period]
        const candles = await this.cbService.getCandles(data.pair, period / 1000)
        this.activePairs[data.pair].pricePeriods = candles.map(c => (c.close))
        await this.redis.hmset(`algorithms:ema1226:coinbase:${data.pair}`, { ...data })
    }

    /**
     * Calculate moving avg
     * @param data 
     */
    private _calcMovingAvg(data: ClockEvent, period: ClockIntervalText) {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period !== period) return
        if (!data.avgTradePrice) return

        // --- calculate moving averages ---
        const p = ClockInterval[period]
        const tPeriods = Math.round((new Date().getTime() - this.activePairs[data.pair].startTime) / p)
        console.log(`calculating period: ${tPeriods}`)

        // prices
        this.activePairs[data.pair].pricePeriods.push(Number(data.avgTradePrice))

        // calculate moving averages
        if (this.activePairs[data.pair].pricePeriods.length >= 26) {
            this.activePairs[data.pair].ema12 = ema(this.activePairs[data.pair].pricePeriods, 12)
            this.activePairs[data.pair].ema26 = ema(this.activePairs[data.pair].pricePeriods, 26)
            // shift one off
            this.activePairs[data.pair].pricePeriods.shift()

            // TODO emit to analyzer
            // this.redis.set(`algorithm:ema1226:12:${this.pair}`, JSON.stringify(this.ema12))
            // this.redis.set(`algorithm:ema1226:26:${this.pair}`, JSON.stringify(this.ema26))
        }
    }
}
