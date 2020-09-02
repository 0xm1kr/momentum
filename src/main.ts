#!/usr/bin/env node
import * as yargs from 'yargs'
import { logInfo } from './utils/log'
import './utils/env'

const ENV = process.env.ENVIRONMENT || 'DEV'

// CLI interface
// ---------------------------
logInfo('')
logInfo('###################################')
logInfo(`#       :moneybag: :money_with_wings: CBP Bot :money_with_wings: :moneybag:       #`)
logInfo('#      --------------------       #')
logInfo(`#        Environment: ${ENV}         #`)
logInfo('###################################')
logInfo('')

// prettier-ignore
yargs
  .scriptName('cbp-bot')
  .commandDir('commands')
  .demandCommand(1)
  .help()
  .version()
  .argv