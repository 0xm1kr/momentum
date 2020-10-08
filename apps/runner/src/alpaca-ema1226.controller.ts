import { Controller, Inject } from '@nestjs/common'
import { ClientProxy, EventPattern } from '@nestjs/microservices'
import { RedisService } from 'nestjs-redis'
import { Redis } from 'ioredis'
import { ema } from 'moving-averages'
import bn from 'big.js'
import { AlgorithmEvent, ClockEvent, ClockInterval, ClockIntervalText, EMAEvent, TradeEvent } from '@momentum/events'
import { AlpacaService, Granularity } from '@momentum/alpaca-client'

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
export class AlpacaEMA1226Controller {
    constructor(
        @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
        private readonly redisSvc: RedisService,
        private readonly alpSvc: AlpacaService
    ) { }

    // TODO move all of this to a service
    private redis: Redis
    private activePairs: ActivePairs = {}

    async onApplicationBootstrap() {
        // connect to store
        this.redis = this.redisSvc.getClient('momentum-state')

        // check for running algos
        const algos = await this.redis.keys('algorithms:ema1226:alpaca:*')
        if (algos.length) {
            for (const a of algos) {
                const params = await this.redis.hgetall(a) as unknown
                console.log('params', params)
                const lastTrade = await this.redis.hgetall(`trade:alpaca:ema1226:${(params as AlgorithmEvent).pair}`)
                console.log('lastTrade', lastTrade)
                this._start({
                    ...params as AlgorithmEvent,
                    lastTrade: Object.keys(lastTrade).length 
                        ? `${lastTrade.side},${lastTrade.price},${lastTrade.time}` 
                        : (params as AlgorithmEvent).lastTrade
                })
            }
        }
    }

    @EventPattern('update:alpaca')
    async handleUpdate(data: ClockEvent) {
        if (!this.activePairs[data.pair]) return

        if (this.activePairs[data.pair].ema26.length) {
            const bestAsk = data.bestAsk
            const bestBid = data.bestBid
            const ema12 = bn(this.activePairs[data.pair].ema12[this.activePairs[data.pair].ema12.length - 1])
            const ema26 = bn(this.activePairs[data.pair].ema26[this.activePairs[data.pair].ema26.length - 1])
            const ema12Slope = bn(this.activePairs[data.pair].ema12[this.activePairs[data.pair].ema12.length - 1])
                .minus(bn(this.activePairs[data.pair].ema12[this.activePairs[data.pair].ema12.length - 2]))
            const ema26Slope = bn(this.activePairs[data.pair].ema26[this.activePairs[data.pair].ema26.length - 1])
                .minus(bn(this.activePairs[data.pair].ema26[this.activePairs[data.pair].ema26.length - 2]))

            console.log('-------------------------')
            console.log('-----',data.pair,'-----')
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
                const lastTotal = bn(lastBuyPrice).plus((bn(lastBuyPrice).times(0.001))) // min profit to capture
                const curFee = bn(bestAsk[0]).times(0.001) // based on exchange fee?
                const reqPrice = lastTotal.plus(curFee)
                console.log('required sell price:', reqPrice.toString())
                if (!this.activePairs[data.pair].lastSell && (!this.activePairs[data.pair].lastBuy || reqPrice.lt(bestAsk[0]))) {
                    const order = {
                        pair: data.pair,
                        size: this.activePairs[data.pair].size,
                        side: 'sell',
                        price: bestAsk[0],
                        time: new Date().getTime()
                    }
                    try {
                        // TODO go live
                        // TODO what if this never fills?
                        // const o = await this.alpSvc.limitOrder(data.pair, order)
                        // console.log(0)
                        const trade = {
                            ...order,
                            delta: this._getOrderDelta(data.pair, order),
                            exchange: 'alpaca'
                        }
                        this.activePairs[data.pair].lastSell = order
                        this.activePairs[data.pair].lastBuy = null
                        this.momentum.emit('trade:alpaca', trade)
                        this.redis.hmset(`trade:alpaca:ema1226:${data.pair}`, trade)
                        
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
                const lastTotal = bn(lastSellPrice).minus((bn(lastSellPrice).times(0.001))) // max dip before going long
                const curFee = bn(bestBid[0]).times(0.001) // based on exchange fee?
                const reqPrice = lastTotal.minus(curFee)
                console.log('required buy price', reqPrice.toString())
                if (!this.activePairs[data.pair].lastBuy && (!this.activePairs[data.pair].lastSell || bn(reqPrice).gt(bestBid[0]))) {
                    const order = {
                        pair: data.pair,
                        size: this.activePairs[data.pair].size,
                        side: 'buy',
                        price: bestBid[0],
                        time: new Date().getTime()
                    }
                    try {
                        // TODO go live
                        // TODO what if this never fills?
                        // const o = await this.alpSvc.limitOrder(data.pair, order)
                        // console.log(o)
                        const trade = {
                            ...order,
                            delta: this._getOrderDelta(data.pair, order),
                            exchange: 'alpaca'
                        }
                        this.activePairs[data.pair].lastBuy = order
                        this.activePairs[data.pair].lastSell = null
                        this.redis.hmset(`trade:alpaca:ema1226:${data.pair}`, trade)
                        this.momentum.emit('trade:alpaca', trade)
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
    @EventPattern('clock:1m:alpaca')
    async handleOneMin(data: ClockEvent): Promise<void> {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period === '1m') {
            this._calcMovingAvg(data, ClockIntervalText.OneMinute)
        }
    }

    /**
     * calculate 5min 12/26 moving average
     */
    @EventPattern('clock:5m:alpaca')
    async handleFiveMin(data: ClockEvent): Promise<void> {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period === '5m') {
            this._calcMovingAvg(data, ClockIntervalText.FiveMinute)
        }
    }

    /**
     * calculate 15min 12/26 moving average
     */
    @EventPattern('clock:15m:alpaca')
    async handleFifteenMin(data: ClockEvent): Promise<void> {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period === '15m') {
            this._calcMovingAvg(data, ClockIntervalText.FifteenMinute)
        }
    }

    @EventPattern('stop:ema1226:alpaca')
    async handleStop(data: AlgorithmEvent) {
        console.log('stopping', data.pair)
        delete this.activePairs[data.pair]
        await this.redis.del(`algorithms:ema1226:alpaca:${data.pair}`)
    }

    @EventPattern('start:ema1226:alpaca')
    async handleStart(data: AlgorithmEvent) {
        // persist config
        await this.redis.hmset(`algorithms:ema1226:alpaca:${data.pair}`, { ...data })
        // start
        await this._start(data)
    }

    /**
     * Start running an algo
     * 
     * @param data 
     * @param restart 
     */
    private async _start(data: AlgorithmEvent) {
        const startTime = new Date()

        // set active
        this.activePairs[data.pair] = {
            pair: data.pair,
            startTime: startTime.getTime(),
            period: data.period,
            size: data.size,
            lastBuy: null,
            lastSell: null,
            pricePeriods: [],
            ema12: [],
            ema26: [],
        }

        // previous trades
        if (data.lastTrade) {
            const lt = data.lastTrade.split(',')
            const order = {
                side: lt[0],
                size: data.size,
                price: lt[1],
                time: Number(lt[2]) || new Date().getTime()
            }
            if (lt[0] === 'buy') {
                this.activePairs[data.pair].lastBuy = order
            }
            if (lt[0] === 'sell') {
                this.activePairs[data.pair].lastSell = order
            }
            // persist last trade
            // NOTE: overwrites last trade!
            this.redis.hmset(`trade:alpaca:ema1226:${data.pair}`, order)
        }

        // log info
        console.log(`STARTING: EMA 12 / 26: ${startTime.toISOString()}`, JSON.stringify(this.activePairs[data.pair], null, 2))

        // backfill price data
        // TODO more than USD?
        const symbol = data.pair.split('-')[1]
        const clockP = {
            '1m'  : '1Min',
            '5m'  : '5Min',
            '15m' : '15Min'
        }
        const candles = await this.alpSvc.getBars(symbol, clockP[data.period])
        this.activePairs[data.pair].pricePeriods = candles[symbol].map(c => (c.c))
    }

    /**
     * Calc delta from last trade
     * 
     * @param pair 
     * @param order 
     */
    private _getOrderDelta(pair: string, order: Trade) {
        let delta = '0'
        const active = this.activePairs[pair]
        const lastBuy = this.activePairs[pair].lastBuy
        const lastSell = this.activePairs[pair].lastSell
        if (order.side === 'sell' && lastBuy) {
            const diff = bn(order.price).minus(lastBuy.price)
            delta = diff.times(active.size).toString()
        } 
        if (order.side === 'buy' && lastSell) {
            const diff = bn(lastSell.price).minus(order.price)
            delta = diff.times(active.size).toString()
        }
        return delta
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
        if (this.activePairs[data.pair].pricePeriods.length >= 12) {
            this.activePairs[data.pair].ema12 = ema(this.activePairs[data.pair].pricePeriods, 12)
            
            // emit for analysis
            const length = this.activePairs[data.pair].ema12.length
            this.momentum.emit('ema:alpaca', new EMAEvent(
                'alpaca',
                data.pair,
                12,
                this.activePairs[data.pair].ema12[length - 1],
                new Date().getTime()
            ))
            
            // shift one off
            this.activePairs[data.pair].pricePeriods.shift()
        }
        if (this.activePairs[data.pair].pricePeriods.length >= 26) {
            this.activePairs[data.pair].ema26 = ema(this.activePairs[data.pair].pricePeriods, 26)

            // emit for analysis
            const length = this.activePairs[data.pair].ema26.length
            this.momentum.emit('ema:alpaca', new EMAEvent(
                'alpaca',
                data.pair,
                26,
                this.activePairs[data.pair].ema26[length - 1],
                new Date().getTime()
            ))
        }
    }
}
