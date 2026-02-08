/**
 * Binance Futures Trading Bot - Entry Scanner
 * 
 * This script continuously scans all available USDT-margined perpetual futures contracts on Binance.
 * It calculates short-period RSI (default 5) and EMA20, then opens LONG or SHORT positions 
 * based on extreme RSI values + price < $1 filter.
 * 
 * Features:
 * - Only one active position allowed (MAX_ACTIVE_POSITIONS = 1)
 * - Fixed position size in USDT with leverage
 * - Telegram notifications on position open
 * - Very short RSI period → high-frequency / scalping oriented strategy
 * 
 * @requires ccxt, tulind, node-binance-api, technicalindicators, node-telegram-bot-api
 * @requires .env file with: API_KEY, API_SECRET, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
 */

const MAX_ACTIVE_POSITIONS = 1;
const POSITION_USDT = 5;
const SELL_RSI_THRESHOLD = 80;
const BUY_RSI_THRESHOLD = 10;
const SHORT = true, LONG = false, NEW_TOKEN = true;

// Disable unnecessary warnings and clear console
process.removeAllListeners('warning');
process.noDeprecation = true;
console.clear();

// ────────────────────────────────────────────────
// External dependencies
// ────────────────────────────────────────────────
import ccxt from 'ccxt';
import tulind from 'tulind';
import Binance from 'node-binance-api';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { EMA, RSI } from 'technicalindicators';

dotenv.config();

// ────────────────────────────────────────────────
// ANSI color codes for console output
// ────────────────────────────────────────────────
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const BRIGHT_RED = '\x1b[91m';
const BRIGHT_GREEN = '\x1b[92m';
const BRIGHT_YELLOW = '\x1b[93m';
const BRIGHT_BLUE = '\x1b[94m';
const BRIGHT_MAGENTA = '\x1b[95m';
const BRIGHT_CYAN = '\x1b[96m';
const BRIGHT_WHITE = '\x1b[97m';

// ────────────────────────────────────────────────
// Configuration Constants
// ────────────────────────────────────────────────
const EXCLUDED_SYMBOLS = ['USDCUSDT'];
const TESTING_MODE = false;
const LEVERAGE = 3;
const TIMEFRAME = '1m';
const RSI_PERIOD = 5;
const AMOUNT_PER_POSITION = POSITION_USDT * LEVERAGE;

// ────────────────────────────────────────────────
// Environment variables
// ────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

// ────────────────────────────────────────────────
// Binance API clients initialization
// ────────────────────────────────────────────────
const binance = new ccxt.binance({
    apiKey: API_KEY,
    secret: API_SECRET,
    enableRateLimit: true,
    options: {
        defaultType: 'future'
    }
});

const binanceOptions = new Binance().options({
    APIKEY: API_KEY,
    APISECRET: API_SECRET,
    useServerTime: true,
    test: false
});

// Telegram bot (used only for notifications)
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

const TELEGRAM_MESSAGE_PREFIX = ``;
const TELEGRAM_MESSAGE_SUFFIX = `\n- Sent from Binance`;

// ────────────────────────────────────────────────
// Utility Functions
// ────────────────────────────────────────────────

/**
 * Sleep / delay helper
 * @param {number} ms milliseconds to wait
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sends formatted message to Telegram chat
 * @param {string} message 
 */
const sendTelegramMessage = async (message) => {
    try {
        const formattedMessage = message.replace(/,/g, '\n');
        const finalMessage = `${TELEGRAM_MESSAGE_PREFIX}${formattedMessage}${TELEGRAM_MESSAGE_SUFFIX}`;
        await bot.sendMessage(TELEGRAM_CHAT_ID, finalMessage);
        console.log(` Telegram message sent: ${YELLOW}${finalMessage}${RESET}(Binance)`);
    } catch (error) {
        console.log(`${RED}Failed to send Telegram message: ${error.message}${RESET}&showExtraInfo=false`);
    }
};

/**
 * Fetch recent OHLCV candles using ccxt
 * @param {string} symbol e.g. BTC/USDT
 * @param {number} [limit=100]
 * @returns {Promise<Array<{timestamp:number, open:number, high:number, low:number, close:number, volume:number}>>}
 */
const fetchOHLCV = async (symbol, limit = 100) => {
    try {
        const ohlcv = await binance.fetchOHLCV(symbol, TIMEFRAME, undefined, limit);
        return ohlcv.map(candle => ({
            timestamp: candle[0],
            open: candle[1],
            high: candle[2],
            low: candle[3],
            close: candle[4],
            volume: candle[5]
        }));
    } catch (error) {
        throw new Error(`Failed to fetch OHLCV for ${symbol}: ${error.message}`);
    }
};

/**
 * Calculate latest RSI value using tulind
 * @param {string} symbol 
 * @returns {Promise<{symbol:string, timeframe:string, rsi:number, timestamp:number, lastClose:number, market:string}>}
 */
const calculateRSI = async (symbol) => {
    try {
        const ohlcv = await fetchOHLCV(symbol);
        const closePrices = ohlcv.map(candle => candle.close);
        const rsi = await tulind.indicators.rsi.indicator([closePrices], [RSI_PERIOD]);
        const latestRSI = rsi[0][rsi[0].length - 1];
        return {
            symbol,
            timeframe: TIMEFRAME,
            rsi: latestRSI,
            timestamp: ohlcv[ohlcv.length - 1].timestamp,
            lastClose: closePrices[closePrices.length - 1],
            market: 'futures'
        };
    } catch (error) {
        throw new Error(`Failed to calculate RSI for ${symbol}: ${error.message}`);
    }
};

/**
 * Convert Binance symbol format BTCUSDT → BTC/USDT
 * @param {string} symbol 
 * @returns {string}
 */
const normalizeSymbol = (symbol) => {
    if (symbol.includes('USDT') && !symbol.includes('/')) {
        return symbol.replace('USDT', '/USDT');
    }
    return symbol;
};

/**
 * Get available USDT balance in futures wallet
 * @returns {Promise<number>}
 */
const getBalance = async () => {
    try {
        const balance = await binance.fetchBalance();
        const usdtBalance = balance.free?.USDT || 0;
        console.log(` USDT Balance: ${usdtBalance}`);
        return usdtBalance;
    } catch (error) {
        throw new Error(`Failed to fetch balance: ${error.message}`);
    }
};

/**
 * Set leverage for a symbol
 * @param {string} symbol 
 * @param {number} leverage 
 */
const setLeverage = async (symbol, leverage) => {
    try {
        await binance.setLeverage(leverage, symbol);
        console.log(` Leverage set to ${leverage}x for ${symbol}`);
    } catch (error) {
        console.error(`Failed to set leverage for ${symbol}: ${error.message}`);
    }
};

/**
 * Force margin type to CROSSED (if not already)
 * @param {string} symbol 
 */
const setMarginMode = async (symbol) => {
    try {
        await binance.fapiPrivatePostMarginType({ symbol: symbol.replace(':USDT', ''), marginType: 'CROSSED' });
        console.log(` Margin mode set to CROSSED for ${symbol}`);
    } catch (error) {
        if (error.message.includes('No need to change margin type')) {
            console.log(` Margin mode already set to CROSSED for ${symbol}`);
        } else {
            console.error(`Failed to set margin mode for ${symbol}: ${error.message}`);
        }
    }
};

/**
 * Get current market (last) price
 * @param {string} symbol 
 * @returns {Promise<number>}
 */
const getMarketPrice = async (symbol) => {
    try {
        const ticker = await binance.fetchTicker(symbol);
        const price = ticker.last || ticker.info?.lastPrice;
        if (!price) throw new Error('Price not found in ticker data');
        return price;
    } catch (error) {
        throw new Error(`Failed to fetch market price for ${symbol}: ${error.message}`);
    }
};

/**
 * Fetch current funding rate and next funding time
 * @param {string} symbol 
 * @returns {Promise<{symbol:string, fundingRate:number, nextFundingTime:string, timestamp:number}|null>}
 */
const fetchFundingRate = async (symbol) => {
    try {
        const fundingRate = await binance.fetchFundingRate(symbol);
        const nextFundingDate = new Date(Number(fundingRate.info.nextFundingTime));
        return {
            symbol,
            fundingRate: fundingRate.fundingRate * 100,
            nextFundingTime: `${nextFundingDate.getUTCHours().toString().padStart(2, '0')}:${nextFundingDate.getUTCMinutes().toString().padStart(2, '0')}:${nextFundingDate.getUTCSeconds().toString().padStart(2, '0')},${nextFundingDate.getUTCDate().toString().padStart(2, '0')}/${(nextFundingDate.getUTCMonth() + 1).toString().padStart(2, '0')}/${nextFundingDate.getUTCFullYear()}`,
            timestamp: fundingRate.timestamp
        };
    } catch (error) {
        console.error(`Failed to fetch funding rate for ${symbol}: ${error.message}`);
        return null;
    }
};

/**
 * Check if symbol already has an open futures position
 * @param {string} symbol 
 * @returns {Promise<boolean>}
 */
const alreadyOpenedFuturesPosition = async (symbol) => {
    try {
        const positionData = await binanceOptions.futuresPositionRisk();
        return positionData.some(position => position.symbol === symbol && Number(position.positionAmt) !== 0);
    } catch (error) {
        console.error(`Failed to check open positions for ${symbol}: ${error.message}`);
        return false;
    }
};

/**
 * Open new LONG or SHORT market position
 * @param {string} symbol 
 * @param {'Buy'|'Sell'} side 
 * @returns {Promise<any>|undefined}
 */
const openPosition = async (symbol, side) => {
    try {
        const positionData = await binanceOptions.futuresPositionRisk();
        if (positionData.length >= MAX_ACTIVE_POSITIONS) {
            console.log(`Maximum number of active positions reached.`);
            await sendTelegramMessage(`🚨 Maximum number of active positions reached.`);
            return;
        }

        const balance = await getBalance();
        if (balance < POSITION_USDT) {
            console.log(`Insufficient USDT balance: ${balance} available, ${POSITION_USDT} required.`);
            await sendTelegramMessage(`🚨 Insufficient USDT balance: ${balance} available, ${POSITION_USDT} required.`);
            return;
        }

        const price = await getMarketPrice(symbol);
        const quantity = AMOUNT_PER_POSITION / price;
        const positionSide = side === 'Buy' ? 'LONG' : 'SHORT';
        const params = {
            marginMode: 'isolated',
            positionSide: positionSide
        };
        const order = await binance.createOrder(symbol, 'market', side, quantity, null, params);
        console.log(` Position opened: ${side} ${quantity} ${symbol} at ${price} (${positionSide})`);
        await sendTelegramMessage(`🟢 Position opened: ${symbol}, Quantity: ${quantity}, Price: ${price}, Position Side: ${positionSide}`);
        return order;
    } catch (error) {
        console.error(`Failed to open position for ${symbol}: ${error.message}`);
    }
};

/**
 * Fetch klines (candles) and exclude current (incomplete) candle
 * @param {string} symbol 
 * @param {string} [interval='1m']
 * @param {number} [limit=200]
 * @returns {Promise<Array<{close:number, timestamp:number}>>}
 */
async function fetchKlines(symbol, interval = '1m', limit = 200) {
    try {
        const klines = await binance.fetchOHLCV(symbol, interval, undefined, limit);
        const now = Date.now();
        const lastCandle = klines[klines.length - 1];
        const candleTime = lastCandle[0];
        const intervalMs = 1 * 60 * 1000;
        if (now - candleTime < intervalMs) {
            klines.pop(); // Remove incomplete candle
        }
        return klines.map(k => ({
            close: parseFloat(k[4]),
            timestamp: k[0],
        }));
    } catch (error) {
        throw new Error(`Failed to fetch klines: ${error.message}`);
    }
}

/**
 * Calculate EMA using technicalindicators library
 * @param {number[]} closePrices 
 * @param {number} [p=5] 
 * @returns {number[]}
 */
function calculateEMA(closePrices, p = 5) {
    const ema = EMA.calculate({
        period: p,
        values: closePrices,
    });
    return ema;
}

/**
 * Manual EMA calculation (alternative implementation)
 * @param {number[]} closePrices 
 * @param {string|number} [per='5'] 
 * @returns {number[]}
 */
function calculateManualEMA(closePrices, per = '5') {
    const period = Number(per);
    const k = 2 / (period + 1);
    let ema = closePrices[0];
    const emaValues = [ema];
    for (let i = 1; i < closePrices.length; i++) {
        ema = (closePrices[i] * k) + (ema * (1 - k));
        emaValues.push(ema);
    }
    return emaValues;
}

// ────────────────────────────────────────────────
// Main Loop
// ────────────────────────────────────────────────

/**
 * Main scanning & trading loop
 * Runs forever, scans all symbols every ~60 seconds
 */
const main = async () => {
    while (true) {
        try {
            console.clear();
            const balance = await getBalance();

            const exchangeInfo = await binanceOptions.futuresExchangeInfo();
            const symbols = exchangeInfo.symbols
                .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
                .map(s => s.symbol);

            for (const symbol of symbols) {
                try {
                    if (EXCLUDED_SYMBOLS.includes(symbol)) continue;
                    
                    console.log('.............................................');
                    console.log(` ${YELLOW}${symbol}${RESET}:`); 
                   
                    const normalizedSymbol = normalizeSymbol(symbol);
                    const [rsiResult, fundingRate] = await Promise.all([
                        calculateRSI(normalizedSymbol),
                        fetchFundingRate(normalizedSymbol)
                    ]);                  
                    console.log(` RSI: ${GREEN}${rsiResult.rsi.toFixed(2)}${RESET}`);    
                    const klines = await fetchKlines(symbol, '1m', 500);
                    const closePrices = klines.map(k => k.close);
                    const ema20Values = calculateEMA(closePrices, 20);
                    const latestEMA20 = ema20Values[ema20Values.length - 1];
                    console.log(` EMA20: ${GREEN}${latestEMA20}${RESET}`);
                    const latestPrice = closePrices[closePrices.length - 1];
                    console.log(` Latest Price: ${GREEN}${latestPrice}${RESET}`);                    
                    console.log('');
                    if (fundingRate) {
                        console.log(` Funding Rate: ${fundingRate.fundingRate > 0 ? GREEN : RED}${fundingRate.fundingRate.toFixed(4)}%${RESET}`);
                        console.log(` Next Funding Time: ${CYAN}${fundingRate.nextFundingTime}${RESET}`);
                    }
                    console.log('');
                    const price = await getMarketPrice(normalizedSymbol);
                    await Promise.all([
                        setLeverage(symbol, LEVERAGE),
                        setMarginMode(symbol)
                    ]);

                    if (await alreadyOpenedFuturesPosition(symbol)) continue;                  
                    const message = `📢 ${symbol}: RSI=${rsiResult.rsi.toFixed(2)}, Price=${price}, FundingRate=${fundingRate?.fundingRate ?? 'N/A'}%, NextFunding=${fundingRate?.nextFundingTime ?? 'N/A'}`;
                    
                    if (rsiResult.rsi >= SELL_RSI_THRESHOLD && !TESTING_MODE && price < 1 && SHORT) {
                        await sendTelegramMessage(message);
                        await openPosition(symbol, 'sell');
                    } else if (rsiResult.rsi <= BUY_RSI_THRESHOLD && rsiResult.rsi > 0 && !TESTING_MODE && price < 1 && LONG) {
                        await sendTelegramMessage(message);
                        await openPosition(symbol, 'buy');
                    }                   
                    await sleep(500);
                } catch (error) {
                    console.error(`Error processing ${symbol}: ${error.message}`);
                }
            }
            await sleep(60 * 1000); // wait 1 min before next iteration
        } catch (err) {
            console.error(`Error in main loop: ${err.message}`);
        }
    }
};

main();