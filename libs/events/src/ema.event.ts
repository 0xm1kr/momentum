
export class EMAEvent {
    exchange: string
    pair: string
    period: number
    ema: number
    time: number

    /**
     * Event emitted on new ema calc
     * 
     * @param exchange 
     * @param pair 
     * @param period 
     * @param ema 
     * @param time 
     */
    constructor(
        exchange: string,
        pair: string,
        period: number,
        ema: number,
        time: number
    ) {
        this.exchange = exchange
        this.pair = pair,
        this.period = period
        this.ema = ema
        this.time = time
    }
}