import * as emoji from 'node-emoji'
import * as chalk from 'chalk'
import { resolve } from 'path'
import { writeFileSync, createWriteStream } from 'fs'

export const log = console.log // eslint-disable-line no-console
export const logError = (s: string): void => log(emoji.emojify(chalk.bold.red(s)))
export const logInfo = (s: string): void => log(emoji.emojify(chalk.bold(s)))
export const logDetail = (s: string): void => log(emoji.emojify(chalk.dim(s)))
export const logFile = (data: unknown): void => {
    const d = JSON.stringify(data)
    const path = resolve('/tmp/', 'cbp-bot.log')

    log(emoji.emojify(chalk.bold(d)))

    try {
        const stream = createWriteStream(path, { flags:'a' })
        stream.write(d + "\n")
        stream.end()
    } catch(e) {
        writeFileSync(path, d)
    }
}