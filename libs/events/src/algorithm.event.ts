import { ClockIntervalText } from './clock.event'

export class AlgorithmEvent {
    algorithm: string
    pair: string
    exchange: string
    period: ClockIntervalText
    size: string
    lastTrade: string // TODO change to starting trade?

    /**
     * Required params to start a new algo
     * 
     * @param pair 
     * @param size 
     * @param lastTrade 
     * @param exchange 
     * @param algorithm 
     * @param period 
     */
    constructor(
        algorithm,
        exchange,
        pair,
        size = '1',
        period = ClockIntervalText.OneMinute,
        lastTrade = ''
    ) {
        this.algorithm = algorithm
        this.exchange = exchange
        this.pair = pair
        this.period = period
        this.size = size
        this.lastTrade = lastTrade
    }
}