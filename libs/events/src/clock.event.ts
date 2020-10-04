
export enum ClockIntervalText {
    OneMinute = '1m',
    FiveMinute = '5m',
    FifteenMinute = '15m',
    OneHour = '1h'
}

export enum ClockInterval {
    '1m' = 60000,
    '5m' = 300000,
    '15m' = 900000
}

export class ClockEvent {
    exchange: string
    pair: string
    interval: ClockIntervalText
    bestBid: string[]
    bestAsk: string[]
    avgTradePrice: string
    avgTradeSize?: string
    avgBidDepth?: string
    avgAskDepth?: string
    time: number

    /**
     * Required params to send a clock event
     * 
     * @param pair 
     * @param size 
     * @param lastTrade 
     * @param exchange 
     * @param algorithm 
     * @param period 
     */
    constructor(
        interval: ClockIntervalText,
        exchange: string,
        pair: string,
        bestBid: string[],
        bestAsk: string[],
        avgTradePrice: string,
        avgTradeSize?: string,
        avgBidDepth?: string,
        avgAskDepth?: string
    ) {
        this.interval = interval
        this.exchange = exchange
        this.pair = pair
        this.bestBid = bestBid
        this.bestAsk = bestAsk
        this.avgTradePrice = avgTradePrice
        this.avgTradeSize = avgTradeSize
        this.avgBidDepth = avgBidDepth
        this.avgAskDepth = avgAskDepth
        this.time = new Date().getTime()
    }
}