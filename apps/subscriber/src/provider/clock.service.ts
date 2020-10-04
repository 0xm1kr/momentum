import { Injectable } from '@nestjs/common'

export enum ClockIntervalText {
    OneSecond = '1s',
    OneMinute = '1m',
    FiveMinute = '5m',
    FifteenMinute = '15m'
}

export enum ClockInterval {
    '1s' = 1000,
    '1m' = 60000,
    '5m' = 300000,
    '15m' = 900000
}

export type Clocks = {
    [key in ClockIntervalText]?: Record<string, NodeJS.Timeout|null>
}

export type ExchangeClocks = Record<string, Clocks>

@Injectable()
export class ClockService {
    protected _clocks: ExchangeClocks = {}

    /**
     * Start a clock
     * 
     * @param exchange 
     * @param interval
     * @param pair 
     */
    public start(
        exchange: string, 
        interval: ClockIntervalText, 
        pair: string,
        handler: (
            interval: ClockIntervalText,
            exchange: string,
            pair: string
        ) => unknown
    ): ExchangeClocks {
        // init
        if (typeof this._clocks[exchange] === 'undefined') {
            this._clocks[exchange] = {}
        }
        if (typeof this._clocks[exchange][interval] === 'undefined') {
            this._clocks[exchange][interval] = {}
        }

        // reset
        if (this._clocks[exchange][interval][pair]) {
            clearInterval(this._clocks[exchange][interval][pair])
        }

        // start
        this._clocks[exchange][interval][pair] = setInterval(
            () => {
                handler(interval, exchange,  pair)
            }, 
            ClockInterval[interval]
        )
        
        // return clocks
        return this._clocks
    }

    /**
     * Stop a clock
     * 
     * @param exchange 
     * @param interval
     * @param pair
     */
    public stop(
        exchange: string, 
        interval: ClockIntervalText, 
        pair: string
    ): void {
       try {
        clearInterval(this._clocks[exchange][interval][pair])
       } catch(err){}
    }
}