import { logInfo } from '../utils/log'
import { askName, AskNameParams } from '../services/hello'

import * as yargs from 'yargs' // eslint-disable-line no-unused-vars

/**
 * The Hello CLI command name
 */
export const command = 'hello'

/**
 * The Hello CLI command description
 */
export const desc = `Let's get to know each other`

/**
 * Hello Command Builder
 */
export const builder: { [key: string]: yargs.Options } = {
    name: { type: 'string', required: false, description: 'your name' }
}

/**
 * Hello Command Handler
 * @param param0 
 */
export async function handler({ name }: AskNameParams): Promise<void> {
    logInfo(`Oh, nice to meet you, ${name || (await askName())}!`)
}