import { Injectable } from '@nestjs/common'

export enum ClockIntervalText {
    OneMinute = '1m',
    FiveMinute = '5m',
    FifteenMinute = '15m'
}

export enum ClockInterval {
    '1m' = 60000,
    '5m' = 300000,
    '15m' = 900000
}

export type Clocks = {
    [key in ClockIntervalText]?: Record<string, NodeJS.Timeout|null>
}

@Injectable()
export class ClockService {
    protected _clocks: Clocks = {}

    public get clocks() {
        return this._clocks
    }

    /**
     * Start a clock
     * 
     * @param exchange 
     * @param interval
     * @param pair 
     */
    public start(
        interval: ClockIntervalText, 
        pair: string,
        handler: (
            interval: ClockIntervalText,
            pair: string
        ) => unknown
    ): Clocks {
        // init
        if (typeof this._clocks[interval] === 'undefined') {
            this._clocks[interval] = {}
        }

        // reset
        if (this._clocks[interval][pair]) {
            clearInterval(this._clocks[interval][pair])
        }

        // start
        this._clocks[interval][pair] = setInterval(
            () => {
                handler(interval, pair)
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
        interval: ClockIntervalText, 
        pair: string
    ): void {
       try {
        clearInterval(this._clocks[interval][pair])
       } catch(err){}
    }
}