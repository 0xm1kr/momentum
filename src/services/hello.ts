import { prompt as ask } from 'inquirer'
import { logInfo } from '../utils/log'

//
// The hello service is a nice
// singleton for all things
// related to saying hello.
//

/**
 * Some predefined delays (in milliseconds).
 */
export enum HelloDelays {
    Short = 500,
    Medium = 2000,
    Long = 5000,
}

/**
 * Command params
 */
export type AskNameParams = { 
    name?: string 
}

/**
 * Ask for someones 
 * name using inquirer
 */
export async function askName(): Promise<string> {
    logInfo(':wave:  Hello stranger!')
    const { name } = await ask([
        {
            type: 'input',
            name: 'name',
            message: "What's your name?"
        }
    ])
    return name;
}