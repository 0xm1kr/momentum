
[![TypeScript version][ts-badge]][typescript-4-0]
[![Node.js version][nodejs-badge]][nodejs]
[![APLv2][license-badge]][license]
[![Build Status - GitHub Actions][gha-badge]][gha-ci]

# Momentum Trading Bot

**WARING: THIS WILL LOSE YOU MONEY IN IT'S CURRENT FORM.**

_THIS PROJECT IS ONLY INTENDED FOR EDUCATIONAL PURPOSES/TO BE USED AS A BOILERPLATE._

---

## Overview

This project makes use of trading algorithms ported from Trading Views "Pine" scripts to trade cryptocurrency on Coinbase Pro and traditional markets on Alpaca.

## Getting Started

### Setup

1. Get [Coinbase Pro Sandbox Credentials](https://public.sandbox.pro.coinbase.com/profile/api)
2. Get [Alpaca Credentials]()
3. `cp .env.example .env`, then copy credentials to this file
4. `npm i`
5. `npm run build` - build the code
6. `npm link` - link the node script
7. `cbp-bot` - run it

### Commands

**CBP**
+ `cbp viewBalances`: shows current balances
+ `cbp viewBook [product]`: view a snapshot of a product book (e.g. "BTC-USD")
+ `cbp watchTicker [product]`: watch a product ticker
+ `cbp watchBook [product]`: watch a product book
+ `cbp purchase [product] [amount]`: market order purchase a token (amount is in quote)

**Twitter**
+ `twitter [keyword]`: stream tweet sentiment based on a keyword

**Algorithm**
+ `run [product] [keyword]`: run trading algorithm using a Twitter keyword

## Development

### Available Scripts

+ `clean` - remove coverage data, Jest cache and transpiled files,
+ `build` - transpile TypeScript to ES6,
+ `build:watch` - interactive watch mode to automatically transpile source files,
+ `lint` - lint source files and tests,
+ `test` - run tests,
+ `test:watch` - interactive watch mode to automatically re-run tests

### Services

+ `CBP`: built on [coinbase-pro-node](https://github.com/bennyn/coinbase-pro-node)
+ `Twitter`: built on [node-twitter](https://github.com/desmondmorris/node-twitter)

### Dependencies

+ [TypeScript][typescript] [3.9][typescript-39]
+ [ESLint][eslint] with some initial rules recommendation
+ [Jest][jest] for fast unit testing and code coverage
+ Type definitions for Node.js and Jest
+ [Prettier][prettier] to enforce consistent code style
+ NPM [scripts](#available-scripts) for common operations
+ Simple example of TypeScript code and unit test
+ .editorconfig for consistent file format
+ Reproducible environments thanks to [Volta][volta]
+ Example configuration for [Travis CI][travis]

### Volta?

This project uses [Volta](https://volta.sh/):
```
"node": "12.18.2",
"npm": "6.14.5"
```

[Volta's](https://volta.sh/) toolchain always keeps track of where you are, it makes sure the tools you use always respect the settings of the project you’re working on. This means you don’t have to worry about changing the state of your installed software when switching between projects. Pretty cool stuff.

## License

🤲 Free as in speech: available under the APLv2 license.

Licensed under the APLv2. See the [LICENSE](https://github.com/manymikes/cbp-twitter-bot/blob/master/LICENSE) file for details.

[ts-badge]: https://img.shields.io/badge/TypeScript-4.0-blue.svg
[nodejs-badge]: https://img.shields.io/badge/Node.js->=%2012.13-blue.svg
[nodejs]: https://nodejs.org/dist/latest-v12.x/docs/api/
[travis-badge]: https://travis-ci.org/manymikes/cbp-twitter-bot.svg?branch=master
[travis-ci]: https://travis-ci.org/manymikes/cbp-twitter-bot
[gha-badge]: https://img.shields.io/endpoint.svg?url=https%3A%2F%2Factions-badge.atrox.dev%2Fmanymikes%2Fcbp-twitter-bot%2Fbadge&style=flat
[gha-ci]: https://github.com/manymikes/cbp-twitter-bot/actions
[typescript]: https://www.typescriptlang.org/
[typescript-4-0]: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-0.html
[license-badge]: https://img.shields.io/badge/license-APLv2-blue.svg
[license]: https://github.com/manymikes/cbp-twitter-bot/blob/master/LICENSE
[sponsor-badge]: https://img.shields.io/badge/♥-Sponsor-fc0fb5.svg
[sponsor]: https://github.com/sponsors/manymikes
[jest]: https://facebook.github.io/jest/
[eslint]: https://github.com/eslint/eslint
[prettier]: https://prettier.io
[volta]: https://volta.sh
[volta-getting-started]: https://docs.volta.sh/guide/getting-started
[volta-tomdale]: https://twitter.com/tomdale/status/1162017336699838467?s=20
[gh-actions]: https://github.com/features/actions
[travis]: https://travis-ci.org
[repo-template-action]: https://github.com/manymikes/cbp-twitter-bot/generate
