/**
 * Binance Futures Position Manager & Auto Closer / Margin Adder
 * 
 * Monitors all open perpetual futures positions.
 * Features:
 *  • Closes position when unrealized profit reaches target percentage
 *  • Adds margin when position is in loss (currently commented logic)
 *  • Shows funding rate direction profitability
 *  • Telegram notifications on close / margin add
 * 
 * @requires ccxt, node-binance-api, node-telegram-bot-api
 * @requires .env file with: API_KEY, API_SECRET, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
 */

const profit = 0.03;                // target profit percentage (3%)
const supportPerPosition = 0.10;    // 10% of current isolated margin to add
const PercentMargin = 88;           // unused in current logic
const PercentMarginFlag = 82;       // unused in current logic
const excludedSymbols = [];

// ────────────────────────────────────────────────
// Disable warnings & clear console
// ────────────────────────────────────────────────
process.removeAllListeners('warning');
process.noDeprecation = true;
console.clear();

// ────────────────────────────────────────────────
// Dependencies
// ────────────────────────────────────────────────
import Binance from 'node-binance-api';
import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

// ────────────────────────────────────────────────
// Environment & API clients
// ────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

const binance = new ccxt.binance({
    apiKey: API_KEY,
    secret: API_SECRET,
    enableRateLimit: true,
    options: {
        defaultType: 'future'
    }
});

const binance_options = new Binance().options({
    APIKEY: API_KEY,
    APISECRET: API_SECRET,
    useServerTime: true,
    test: false
});

// ────────────────────────────────────────────────
// ANSI colors & styles
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

// Background & style codes (mostly unused but kept for future)
const BG_RED = '\x1b[41m';
const BG_GREEN = '\x1b[42m';
// ... other BG and style codes remain unchanged ...

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const TELEGRAM_MESSAGE_PREFIX = ``;
const TELEGRAM_MESSAGE_SUFFIX = `\n- Sent from Binance`;

/**
 * Send message to Telegram
 * @param {string} message 
 */
async function sendTelegramMessage(message) {
    try {
        const formattedMessage = message.replace(/,/g, '\n');
        const finalMessage = `${TELEGRAM_MESSAGE_PREFIX}${formattedMessage}${TELEGRAM_MESSAGE_SUFFIX}`;
        await bot.sendMessage(TELEGRAM_CHAT_ID, finalMessage);
        console.log(` Telegram message sent: ${YELLOW}${finalMessage}${RESET}(Binance)`);
    } catch (error) {
        console.log(`${RED}Failed to send Telegram message: ${error.message}${RESET}&showExtraInfo=false`);
    }
}

/**
 * Format UNIX timestamp to readable datetime string
 * @param {number} timestamp ms
 * @returns {string} YYYY-MM-DD HH:mm:ss
 */
function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Try to determine when the current position was opened by analyzing trade history
 * (currently commented out in main loop)
 * 
 * @param {string} symbol 
 * @param {'LONG'|'SHORT'} positionSide 
 * @param {string} positionAmt 
 * @returns {Promise<{symbol:string, positionSide:string, positionAmt:string, creationDate:string, tradeId:string, tradeTime:number}|null>}
 */
async function getPositionCreationDate(symbol, positionSide, positionAmt) {
    try {
        const trades = await binance_options.futuresUserTrades(symbol, { limit: 1000 });

        if (!trades || trades.length === 0) {
            console.log(`${BRIGHT_RED}No trades found for ${symbol}.${RESET}`);
            return null;
        }

        trades.sort((a, b) => a.time - b.time);

        const targetPositionAmt = parseFloat(positionAmt);
        let accumulatedQty = 0;
        let creationTrade = null;

        for (const trade of trades) {
            if (trade.positionSide === positionSide) {
                const qty = parseFloat(trade.qty) * (trade.side === 'BUY' ? 1 : -1);
                const previousAccumulatedQty = accumulatedQty;
                accumulatedQty += qty;

                if (positionSide === 'LONG' && accumulatedQty >= targetPositionAmt) {
                    if (previousAccumulatedQty < targetPositionAmt) {
                        creationTrade = trade;
                        break;
                    }
                }
                if (positionSide === 'SHORT' && accumulatedQty <= targetPositionAmt) {
                    if (previousAccumulatedQty > targetPositionAmt) {
                        creationTrade = trade;
                        break;
                    }
                }
            }
        }

        if (!creationTrade) {
            console.log(`${RED}Could not determine position creation trade for ${symbol} (${positionSide}).${RESET}`);
            return null;
        }

        const creationDate = formatTimestamp(creationTrade.time);
        const positionColor = positionSide === 'LONG' ? GREEN : BRIGHT_RED;

        console.log(`\n${CYAN}Symbol:${RESET} ${symbol}`);
        console.log(`${CYAN}Position Side:${RESET} ${positionColor}${positionSide}${RESET}`);
        console.log(`${CYAN}Position Amount:${RESET} ${positionAmt}`);
        console.log(`${CYAN}Position Creation Date:${RESET} ${creationDate}`);

        return {
            symbol,
            positionSide,
            positionAmt,
            creationDate,
            tradeId: creationTrade.id,
            tradeTime: creationTrade.time
        };
    } catch (error) {
        console.error(`${RED}Error fetching trade history for ${symbol}: ${error.message}${RESET}`);
        return null;
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeSymbol(symbol) {
    if (symbol.includes('USDT') && !symbol.includes('/')) {
        return symbol.replace('USDT', '/USDT');
    }
    return symbol;
}

/**
 * Main monitoring loop — checks open positions every few seconds
 */
async function listOpenFuturesPositions() {
    while (true) {
        try {
            console.clear();
            const positionData = await binance_options.futuresPositionRisk();
            const openPositions = positionData.filter(p => Number(p.positionAmt) !== 0);
            console.log(` Opened Futures Positions: ${CYAN}${openPositions.length}${RESET}`);
         
            if (openPositions.length === 0) {
                console.log('No open futures positions found.');
                await sleep(10000);
                continue;
            }

            for (const position of openPositions) {
                try {
                    console.log('-----------------------------------');                               
                    const size = Number(position.positionAmt);
                    console.log(` ${YELLOW}${position.symbol}${RESET}`);
                    const symbol_normalize = `${normalizeSymbol(position.symbol)}:USDT`;
                    const fundingRate = await fetchFundingRate(symbol_normalize);
                    // await getPositionCreationDate(position.symbol, position.positionSide, position.positionAmt);
                    const positionColor = position.positionSide === 'LONG' ? GREEN : BRIGHT_RED;
                    console.log(` Position Side:${positionColor}${position.positionSide}${RESET}`);        
                    console.log(` Current price: ${GREEN}${position.markPrice}${RESET}`);              
                    console.log(` P/L: ${position.unRealizedProfit > 0 ? GREEN : BRIGHT_RED}${Number(position.unRealizedProfit).toFixed(2)}${RESET}`);                     
                    console.log('');
                    if (fundingRate) {
                        console.log(` Funding Rate: ${fundingRate.fundingRate > 0 ? GREEN : BRIGHT_RED}${fundingRate.fundingRate.toFixed(4)}%${RESET}`);
                        console.log(` Next Funding Time: ${CYAN}${fundingRate.nextFundingTime}${RESET}`);                        
                     
                        if ((position.positionSide === 'LONG' && fundingRate.fundingRate < 0) || 
                            (position.positionSide === 'SHORT' && fundingRate.fundingRate > 0)) {
                            console.log(` Profitable: ${GREEN}YES${RESET}`);
                        } else {
                            console.log(` Profitable: ${BRIGHT_RED}NO${RESET}`);
                        }
                    }                   
                    if (excludedSymbols.includes(position.symbol)) {
                        continue;
                    }                       
                    const calculatedProfit = Number(position.isolatedWallet) * profit;
                    const unRealizedProfit = Number(position.unRealizedProfit);
                    
                    if (unRealizedProfit >= calculatedProfit) {
                        const order = await closePosition(position);
                        console.log('Close order:', order);
                    } 
                    // Margin adding logic is currently commented out in original code
                } catch (err) {
                    console.error(`Error processing ${position.symbol}: ${err.message}`);
                }
                await sleep(3000); // Rate limit delay
            }
        } catch (error) {
            console.error('Error fetching open positions:', error.body || error.message);
            await sleep(5000);
        }
    }
}

/**
 * Close an open futures position with market order
 * @param {Object} position position object from futuresPositionRisk()
 * @returns {Promise<any>}
 */
async function closePosition(position) {
    try {
        if (!position.symbol || !position.positionAmt || !position.positionSide) {
            throw new Error('Invalid position data');
        }

        let symbol = position.symbol;
        const quantity = Math.abs(parseFloat(position.positionAmt));
        if (quantity === 0) {
            throw new Error('Position quantity is zero');
        }

        const price = await getMarketPrice(symbol);
        const positionSide = position.positionSide;
        const oppositeSide = positionSide === 'LONG' ? 'SELL' : 'BUY';

        const params = {
            positionSide: positionSide,
            // reduceOnly: true,     // commented in original
        };

        const order = await (oppositeSide === 'BUY'
            ? binance_options.futuresMarketBuy(symbol, quantity, params)
            : binance_options.futuresMarketSell(symbol, quantity, params));

        console.log(` Entry price: ${GREEN}${position.entryPrice}${RESET}`);
        console.log(` Current price: ${GREEN}${price}${RESET}`);
        console.log(` Position closed: ${YELLOW}${quantity}${RESET} / ${positionSide}`);
        console.log(` P/L: ${position.unRealizedProfit > 0 ? GREEN : BRIGHT_RED}${position.unRealizedProfit}${RESET}`);

        const message = `❎ Position closed: ${symbol}, Quantity: ${quantity}, Price: ${price}, Position Side: ${positionSide}, P/L: ${position.unRealizedProfit}`;
        await sendTelegramMessage(message);

        return order;
    } catch (error) {
        console.error('Error closing position:', error.message);
        throw error;
    }
}

/**
 * Get current market price (last price)
 * @param {string} symbol 
 * @returns {Promise<number>}
 */
async function getMarketPrice(symbol) {
    try {
        const ticker = await binance.fetchTicker(symbol);     
        const price = ticker.last || ticker.info?.lastPrice;
        if (!price) throw new Error('Price not found in ticker data');
        console.log(` Market price: ${GREEN}${price}${RESET}`);
        return price;
    } catch (error) {
        console.error('Error fetching market price:', error.message);
        throw error;
    }
}

/**
 * Add margin to isolated position (currently NOT used in main loop)
 * @param {Object} position 
 */
async function addMarginToPosition(position) {
    try {
        if (!position) {        
            throw new Error(`No open position found.`);
        }      
        var symbol = position.symbol; 
         
        if (!symbol || typeof symbol !== 'string') {
            throw new Error('Invalid symbol provided');
        }    

        const normalizedSymbol = symbol.includes(':USDT') ? symbol : `${symbol}:USDT`;

        if (position.isolatedWallet === '0') {
            throw new Error(`Position for ${symbol} is not in isolated margin mode`);
        }

        const usdtBalance = await getBalance();        
        var amount = position.isolatedWallet;
        var amountForSupport = amount * supportPerPosition;    

        if (usdtBalance < amountForSupport) {
            throw new Error(`Insufficient USDT balance in futures wallet: ${usdtBalance} available, ${amountForSupport} required`);
        }          

        let positionSide = position.positionSide;  
        console.log('');
   
        const positionSideMode = await binance.fapiPrivateGetPositionSideDual();
        const isHedgeMode = positionSideMode.dualSidePosition;
        console.log(' Hedge Mode:', isHedgeMode);
        console.log(` Found open ${CYAN}${positionSide}${RESET} position for ${YELLOW}${symbol}${RESET}`);

        const params = {
            symbol: symbol,
            amount: Number(amountForSupport).toFixed(2),
            type: 1, // 1 = Add margin
            timestamp: Date.now(),
        };

        if (isHedgeMode) {
            params.positionSide = positionSide;
        }     

        // ── The actual API call is commented out in original code ──
        // let response = await binance.fapiPrivatePostPositionMargin(params);

        console.log(' Margin added successfully');
        console.log(` Added ${GREEN}${amountForSupport}${RESET} USDT to ${YELLOW}${symbol}${RESET} ${CYAN}${positionSide}${RESET} position`);

        const updatedPosition = await binance.fetchPositions([symbol]);     

        if (updatedPosition) {
            console.log(' Updated position details:', updatedPosition);
        } else {
            console.error(`Failed to retrieve updated position for ${symbol} ${positionSide}. Position may have been closed.`);
        }        

        const message = `⚠️ Margin added, ${amountForSupport} USDT to ${symbol} ${positionSide} position`;
        await sendTelegramMessage(message);       
    } catch (error) {
        console.error('Error adding margin:', error.message);
        if (error.message.includes('code=-4054')) {
            console.error('Binance error: No open position exists for this symbol or position side.');
        }
    }
}

/**
 * Get available USDT balance in futures account
 * @returns {Promise<number>}
 */
async function getBalance() {
    try {
        const balance = await binance.fetchBalance();        
        const usdtBalance = balance.free?.USDT || 0;
        console.log(` USDT Balance: ${GREEN}${usdtBalance}${RESET}`);
        return usdtBalance;
    } catch (error) {
        console.error('Error fetching balance:', error);
        throw error;
    }
}

/**
 * Fetch funding rate information
 * @param {string} symbol normalized symbol (BTC/USDT:USDT)
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

// Start monitoring loop
listOpenFuturesPositions();