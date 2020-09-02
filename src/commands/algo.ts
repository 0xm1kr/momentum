import * as yargs from 'yargs' // eslint-disable-line no-unused-vars
import { CBPEma1226 } from '../algorithms/CBPEma1226'
import { log, logError, logDetail } from '../utils/log'

type Params = {
    algo: string
    product: string
}

/**
 * The command name
 */
export const command = 'algo [algo] [product]'

/**
 * The command description
 */
export const desc = `Run the trading algorithm`

/**
 * Command builder
 */
export const builder: { [key: string]: yargs.Options } = {
    algo: { type: 'string', required: true, description: 'Algorithm: cbpema1226|cbp...|alpaca...' },
    product: { type: 'string', required: true, description: 'Product to trade' }
}

/**
 * Command handler
 * @param params 
 */
export async function handler({ algo, product }: Params): Promise<void> {

    // init algo
    const cbpEma1226 = new CBPEma1226({
        period: 1 * 1000 // 1 second for testing
    })

    try {

        // run algos
        switch(algo) {
            case 'cbpema1226':
                await cbpEma1226.run(product)
                break
            default:
                logError(`algorithm not available: ${algo}`)
        }
        
    } catch (error) {
        logError(`:x: action failed! ${product}`)
        logDetail(error.stack)
        log('')
    }
    
}