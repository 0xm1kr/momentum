import { log, logError, logDetail } from '../utils/log'
import { CBPService, CBPParams } from '../services/CBP'

import * as yargs from 'yargs' // eslint-disable-line no-unused-vars

/**
 * The command name
 */
export const command = 'cbp [action] [product] [param]'

/**
 * The command description
 */
export const desc = `Coinbase Pro related commands`

/**
 * Command builder
 */
export const builder: { [key: string]: yargs.Options } = {
    action: { type: 'string', required: true, description: 'viewBalances, viewBook, watchTicker, watchBook, estimateFee, purchase' },
    product: { type: 'string', required: false, description: 'A product for this action e.g. BTC-USD' },
    param: { type: 'string', required: false, description: 'Additional parameter for this action' },
}

/**
 * Command handler
 * 
 * @param params 
 */
export async function handler({ action, product, param }: CBPParams): Promise<void> {
    // get env vars
    const {
        CBP_KEY,
        CBP_SECRET,
        CBP_PASSPHRASE,
        ENVIRONMENT
    } = process.env
    
    // init service
    const cbpService = new CBPService({
        auth: {
            apiKey: CBP_KEY,
            apiSecret: CBP_SECRET,
            passphrase: CBP_PASSPHRASE,
            useSandbox: (ENVIRONMENT === 'DEV') ? true : false
        }
    })

    try {
        await cbpService[action](product, param)
    } catch (error) {
        logError(`:x: action failed! ${action}`)
        logDetail(error.stack)
        log('')
    }
    
}