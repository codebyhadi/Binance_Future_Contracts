# Binance USDT-M Perpetual Futures Bot

Two lightweight Node.js scripts for automated trading on Binance USDT-margined perpetual futures:

- `binance_list_open.js` → Scans all symbols, uses RSI(5) on 1m candles to open LONG (RSI ≤ 10) or SHORT (RSI ≥ 80) positions when price < $1  
- `binance_support_close.js` → Monitors open positions, closes them at +3% profit (of initial margin), shows funding rate profitability

**High risk – experimental code – no stop-loss – use only with funds you can lose completely.**

## Features

- All USDT perpetual contracts scanning
- RSI(5) + EMA20 display
- Fixed size + leverage (default 3×)
- Telegram notifications (open / close / warnings)
- Funding rate direction & next funding time
- Isolated margin + hedge mode compatible
- One position at a time

## Requirements

- Node.js ≥ 18
- Binance Futures API keys (with futures enabled)
- Telegram bot token + chat ID (optional but recommended)

## Installation

```bash
git clone https://github.com/YOUR-USERNAME/binance-futures-bot.git
cd binance-futures-bot
npm install
Rename .env.example to .env file:
envAPI_KEY=xxx
API_SECRET=yyy
TELEGRAM_TOKEN=123456:AAF...
TELEGRAM_CHAT_ID=-1001234567890
Usage
Terminal 1 – Entry scanner
Bashnode binance_list_open.js
# or: npm run start:scanner  (after adding to package.json)
Terminal 2 – Position manager
Bashnode binance_support_close.js
# or: npm run start:manager
Important Constants
binance_list_open.js
JavaScriptconst POSITION_USDT    = 5
const LEVERAGE         = 3
const SELL_RSI_THRESHOLD = 80
const BUY_RSI_THRESHOLD  = 10
const SHORT = true
const LONG  = false
binance_support_close.js
JavaScriptconst profit = 0.03           // 3% target
const supportPerPosition = 0.10  // margin add % (disabled)
Risks – Must Read

No stop-loss → liquidation possible
RSI(5) on 1m = very noisy signals
Price < $1 filter → low liquidity coins only
High funding costs possible
API / network delays can cause issues
Paper trade first

License
MIT – Use at your own risk. No warranty.
