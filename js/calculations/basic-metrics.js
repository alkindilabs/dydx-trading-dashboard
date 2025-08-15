/**
 * Basic Trading Metrics Calculations
 * Core metrics for trading performance analysis
 */

/**
 * Calculate total P&L from trades
 */
export function calculatePnL(trades) {
    if (!trades || trades.length === 0) return 0;
    
    return trades.reduce((total, trade) => {
        return total + (trade.realizedPnl || 0);
    }, 0);
}

/**
 * Calculate unrealized P&L for open positions
 */
export function calculateUnrealizedPnL(positions, currentPrices) {
    if (!positions || positions.length === 0) return 0;
    
    return positions
        .filter(pos => pos.status === 'OPEN')
        .reduce((total, pos) => {
            const currentPrice = currentPrices[pos.market] || pos.entryPrice;
            const pnl = pos.side === 'LONG' 
                ? (currentPrice - pos.entryPrice) * pos.size
                : (pos.entryPrice - currentPrice) * pos.size;
            return total + pnl;
        }, 0);
}

/**
 * Calculate win rate percentage
 */
export function calculateWinRate(trades) {
    if (!trades || trades.length === 0) return 0;
    
    const closedTrades = trades.filter(t => t.realizedPnl !== undefined);
    if (closedTrades.length === 0) return 0;
    
    const wins = closedTrades.filter(t => t.realizedPnl > 0).length;
    return (wins / closedTrades.length) * 100;
}

/**
 * Calculate profit factor (gross profit / gross loss)
 */
export function calculateProfitFactor(trades) {
    if (!trades || trades.length === 0) return 0;
    
    let grossProfit = 0;
    let grossLoss = 0;
    
    trades.forEach(trade => {
        const pnl = trade.realizedPnl || 0;
        if (pnl > 0) {
            grossProfit += pnl;
        } else {
            grossLoss += Math.abs(pnl);
        }
    });
    
    if (grossLoss === 0) return grossProfit > 0 ? 999 : 0;
    return grossProfit / grossLoss;
}

/**
 * Calculate average win amount
 */
export function calculateAverageWin(trades) {
    if (!trades || trades.length === 0) return 0;
    
    const wins = trades.filter(t => t.realizedPnl > 0);
    if (wins.length === 0) return 0;
    
    const totalWins = wins.reduce((sum, t) => sum + t.realizedPnl, 0);
    return totalWins / wins.length;
}

/**
 * Calculate average loss amount
 */
export function calculateAverageLoss(trades) {
    if (!trades || trades.length === 0) return 0;
    
    const losses = trades.filter(t => t.realizedPnl < 0);
    if (losses.length === 0) return 0;
    
    const totalLosses = losses.reduce((sum, t) => sum + Math.abs(t.realizedPnl), 0);
    return totalLosses / losses.length;
}

/**
 * Calculate expectancy (average expected profit per trade)
 */
export function calculateExpectancy(trades) {
    if (!trades || trades.length === 0) return 0;
    
    const winRate = calculateWinRate(trades) / 100;
    const avgWin = calculateAverageWin(trades);
    const avgLoss = calculateAverageLoss(trades);
    
    return (winRate * avgWin) - ((1 - winRate) * avgLoss);
}

/**
 * Calculate risk/reward ratio
 */
export function calculateRiskRewardRatio(trades) {
    const avgWin = calculateAverageWin(trades);
    const avgLoss = calculateAverageLoss(trades);
    
    if (avgLoss === 0) return avgWin > 0 ? 999 : 0;
    return avgWin / avgLoss;
}

/**
 * Calculate consecutive wins
 */
export function calculateMaxConsecutiveWins(trades) {
    if (!trades || trades.length === 0) return 0;
    
    let maxWins = 0;
    let currentWins = 0;
    
    trades.forEach(trade => {
        if (trade.realizedPnl > 0) {
            currentWins++;
            maxWins = Math.max(maxWins, currentWins);
        } else {
            currentWins = 0;
        }
    });
    
    return maxWins;
}

/**
 * Calculate consecutive losses
 */
export function calculateMaxConsecutiveLosses(trades) {
    if (!trades || trades.length === 0) return 0;
    
    let maxLosses = 0;
    let currentLosses = 0;
    
    trades.forEach(trade => {
        if (trade.realizedPnl < 0) {
            currentLosses++;
            maxLosses = Math.max(maxLosses, currentLosses);
        } else {
            currentLosses = 0;
        }
    });
    
    return maxLosses;
}

/**
 * Calculate best trade
 */
export function getBestTrade(trades) {
    if (!trades || trades.length === 0) return null;
    
    return trades.reduce((best, trade) => {
        return (!best || trade.realizedPnl > best.realizedPnl) ? trade : best;
    }, null);
}

/**
 * Calculate worst trade
 */
export function getWorstTrade(trades) {
    if (!trades || trades.length === 0) return null;
    
    return trades.reduce((worst, trade) => {
        return (!worst || trade.realizedPnl < worst.realizedPnl) ? trade : worst;
    }, null);
}

/**
 * Calculate recovery factor (net profit / max drawdown)
 */
export function calculateRecoveryFactor(trades, maxDrawdown) {
    const netProfit = calculatePnL(trades);
    
    if (maxDrawdown === 0) return netProfit > 0 ? 999 : 0;
    return Math.abs(netProfit / maxDrawdown);
}

/**
 * Calculate average hold time
 */
export function calculateAverageHoldTime(positions) {
    if (!positions || positions.length === 0) return 0;
    
    const closedPositions = positions.filter(p => p.status === 'CLOSED' && p.closedAt);
    if (closedPositions.length === 0) return 0;
    
    const totalTime = closedPositions.reduce((sum, pos) => {
        const openTime = new Date(pos.createdAt).getTime();
        const closeTime = new Date(pos.closedAt).getTime();
        return sum + (closeTime - openTime);
    }, 0);
    
    return totalTime / closedPositions.length; // Returns milliseconds
}

/**
 * Calculate average hold time for winners
 */
export function calculateAverageWinHoldTime(positions) {
    if (!positions || positions.length === 0) return 0;
    
    const winners = positions.filter(p => 
        p.status === 'CLOSED' && 
        p.closedAt && 
        p.realizedPnl > 0
    );
    
    if (winners.length === 0) return 0;
    
    const totalTime = winners.reduce((sum, pos) => {
        const openTime = new Date(pos.createdAt).getTime();
        const closeTime = new Date(pos.closedAt).getTime();
        return sum + (closeTime - openTime);
    }, 0);
    
    return totalTime / winners.length;
}

/**
 * Calculate average hold time for losers
 */
export function calculateAverageLossHoldTime(positions) {
    if (!positions || positions.length === 0) return 0;
    
    const losers = positions.filter(p => 
        p.status === 'CLOSED' && 
        p.closedAt && 
        p.realizedPnl < 0
    );
    
    if (losers.length === 0) return 0;
    
    const totalTime = losers.reduce((sum, pos) => {
        const openTime = new Date(pos.createdAt).getTime();
        const closeTime = new Date(pos.closedAt).getTime();
        return sum + (closeTime - openTime);
    }, 0);
    
    return totalTime / losers.length;
}

/**
 * Group trades by time period (hourly, daily, weekly, monthly)
 */
export function groupTradesByPeriod(trades, period = 'daily') {
    const grouped = {};
    
    trades.forEach(trade => {
        const date = new Date(trade.createdAt);
        let key;
        
        switch (period) {
            case 'hourly':
                key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
                break;
            case 'daily':
                key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
                break;
            case 'weekly':
                const weekNumber = getWeekNumber(date);
                key = `${date.getFullYear()}-W${weekNumber}`;
                break;
            case 'monthly':
                key = `${date.getFullYear()}-${date.getMonth()}`;
                break;
            default:
                key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        }
        
        if (!grouped[key]) {
            grouped[key] = [];
        }
        grouped[key].push(trade);
    });
    
    return grouped;
}

/**
 * Get week number for a date
 */
function getWeekNumber(date) {
    const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear = (date - firstDayOfYear) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

/**
 * Calculate statistics by market
 */
export function calculateStatsByMarket(trades) {
    const stats = {};
    
    trades.forEach(trade => {
        const market = trade.market;
        
        if (!stats[market]) {
            stats[market] = {
                trades: [],
                totalPnL: 0,
                wins: 0,
                losses: 0,
                volume: 0
            };
        }
        
        stats[market].trades.push(trade);
        stats[market].totalPnL += trade.realizedPnl || 0;
        stats[market].volume += (trade.size * trade.price) || 0;
        
        if (trade.realizedPnl > 0) {
            stats[market].wins++;
        } else if (trade.realizedPnl < 0) {
            stats[market].losses++;
        }
    });
    
    // Calculate derived metrics for each market
    Object.keys(stats).forEach(market => {
        const marketStats = stats[market];
        marketStats.winRate = marketStats.trades.length > 0 
            ? (marketStats.wins / marketStats.trades.length) * 100 
            : 0;
        marketStats.avgPnL = marketStats.trades.length > 0 
            ? marketStats.totalPnL / marketStats.trades.length 
            : 0;
        marketStats.profitFactor = calculateProfitFactor(marketStats.trades);
    });
    
    return stats;
}