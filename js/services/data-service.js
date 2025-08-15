/**
 * Data Service Layer
 * Manages data fetching, processing, and caching
 */

import { DydxClient } from '../api/dydx-client.js';
import { 
    calculatePnL, 
    calculateWinRate, 
    calculateProfitFactor,
    calculateExpectancy 
} from '../calculations/basic-metrics.js';
import { 
    calculateSharpeRatio,
    calculateSortinoRatio,
    calculateCalmarRatio 
} from '../calculations/advanced-metrics.js';
import { 
    calculateMaxDrawdown,
    calculateVaR,
    calculateCVaR 
} from '../calculations/risk-metrics.js';

export class DataService {
    constructor(client = null) {
        this.client = client || new DydxClient();
        this.cache = new Map();
        this.subscribers = new Map();
        this.updateInterval = null;
    }

    /**
     * Load comprehensive portfolio data
     */
    async loadPortfolioData(address, subaccountNumber = 0) {
        try {
            // Check cache first
            const cacheKey = `portfolio_${address}_${subaccountNumber}`;
            const cached = this.getCachedData(cacheKey);
            
            if (cached && Date.now() - cached.timestamp < 30000) { // 30 second cache
                return cached.data;
            }

            // Fetch all data in parallel
            const rawData = await this.client.getComprehensiveAccountData(address, subaccountNumber);
            
            // Process and enrich the data
            const processedData = await this.processPortfolioData(rawData);
            
            // Cache the processed data
            this.setCachedData(cacheKey, processedData, 30000);
            
            // Notify subscribers
            this.notifySubscribers('portfolio', processedData);
            
            return processedData;
        } catch (error) {
            console.error('Failed to load portfolio data:', error);
            throw error;
        }
    }

    /**
     * Process raw portfolio data and calculate metrics
     */
    async processPortfolioData(rawData) {
        const { account, positions, fills, funding, historicalPnl } = rawData;
        
        // Extract account summary
        const accountSummary = this.processAccountData(account);
        
        // Process positions
        const processedPositions = this.processPositions(positions);
        
        // Process trades
        const processedTrades = this.processFills(fills);
        
        // Calculate basic metrics
        const basicMetrics = {
            totalPnL: calculatePnL(processedTrades),
            winRate: calculateWinRate(processedTrades),
            profitFactor: calculateProfitFactor(processedTrades),
            expectancy: calculateExpectancy(processedTrades)
        };
        
        // Calculate advanced metrics
        const returns = this.calculateReturns(historicalPnl);
        const advancedMetrics = {
            sharpeRatio: calculateSharpeRatio(returns),
            sortinoRatio: calculateSortinoRatio(returns),
            calmarRatio: calculateCalmarRatio(returns, basicMetrics.maxDrawdown)
        };
        
        // Calculate risk metrics
        const riskMetrics = {
            maxDrawdown: calculateMaxDrawdown(historicalPnl),
            valueAtRisk: calculateVaR(returns, 0.95),
            conditionalVaR: calculateCVaR(returns, 0.95)
        };
        
        // Process funding data
        const fundingAnalysis = this.processFunding(funding);
        
        // Aggregate everything
        return {
            address: rawData.account.address,
            timestamp: Date.now(),
            account: accountSummary,
            positions: processedPositions,
            trades: processedTrades,
            metrics: {
                ...basicMetrics,
                ...advancedMetrics,
                ...riskMetrics
            },
            funding: fundingAnalysis,
            historicalPnl: historicalPnl,
            raw: rawData
        };
    }

    /**
     * Process account data
     */
    processAccountData(accountData) {
        const subaccount = accountData.subaccount || {};
        
        return {
            equity: parseFloat(subaccount.equity || 0),
            freeCollateral: parseFloat(subaccount.freeCollateral || 0),
            marginUsage: parseFloat(subaccount.marginUsage || 0),
            leverage: this.calculateLeverage(subaccount),
            buyingPower: parseFloat(subaccount.buyingPower || 0),
            quoteBalance: parseFloat(subaccount.quoteBalance?.amount || 0)
        };
    }

    /**
     * Process positions data
     */
    processPositions(positionsData) {
        const positions = positionsData.positions || [];
        
        return positions.map(pos => ({
            market: pos.market,
            status: pos.status,
            side: pos.side,
            size: parseFloat(pos.size || 0),
            entryPrice: parseFloat(pos.entryPrice || 0),
            exitPrice: parseFloat(pos.exitPrice || 0),
            realizedPnl: parseFloat(pos.realizedPnl || 0),
            unrealizedPnl: parseFloat(pos.unrealizedPnl || 0),
            createdAt: pos.createdAt,
            closedAt: pos.closedAt,
            sumOpen: parseFloat(pos.sumOpen || 0),
            sumClose: parseFloat(pos.sumClose || 0),
            netFunding: parseFloat(pos.netFunding || 0)
        }));
    }

    /**
     * Process fills (trades) data
     */
    processFills(fillsData) {
        const fills = fillsData.fills || [];
        
        return fills.map(fill => ({
            id: fill.id,
            market: fill.market,
            side: fill.side,
            type: fill.type,
            price: parseFloat(fill.price || 0),
            size: parseFloat(fill.size || 0),
            fee: parseFloat(fill.fee || 0),
            liquidity: fill.liquidity,
            createdAt: fill.createdAt,
            orderId: fill.orderId
        }));
    }

    /**
     * Process funding payments
     */
    processFunding(fundingData) {
        const payments = fundingData.fundingPayments || [];
        
        const byMarket = {};
        let totalReceived = 0;
        let totalPaid = 0;
        
        payments.forEach(payment => {
            const market = payment.market;
            const amount = parseFloat(payment.payment || 0);
            
            if (!byMarket[market]) {
                byMarket[market] = {
                    received: 0,
                    paid: 0,
                    net: 0,
                    count: 0
                };
            }
            
            if (amount > 0) {
                byMarket[market].received += amount;
                totalReceived += amount;
            } else {
                byMarket[market].paid += Math.abs(amount);
                totalPaid += Math.abs(amount);
            }
            
            byMarket[market].net += amount;
            byMarket[market].count++;
        });
        
        return {
            totalReceived,
            totalPaid,
            netFunding: totalReceived - totalPaid,
            byMarket,
            payments: payments.slice(0, 100) // Keep last 100 for analysis
        };
    }

    /**
     * Calculate returns from historical PnL
     */
    calculateReturns(historicalPnl) {
        if (!historicalPnl || !historicalPnl.historicalPnl) return [];
        
        const pnlData = historicalPnl.historicalPnl;
        const returns = [];
        
        for (let i = 1; i < pnlData.length; i++) {
            const prevEquity = parseFloat(pnlData[i - 1].equity || 0);
            const currEquity = parseFloat(pnlData[i].equity || 0);
            
            if (prevEquity > 0) {
                const returnPct = ((currEquity - prevEquity) / prevEquity) * 100;
                returns.push(returnPct);
            }
        }
        
        return returns;
    }

    /**
     * Calculate leverage
     */
    calculateLeverage(subaccount) {
        const equity = parseFloat(subaccount.equity || 0);
        const notionalValue = parseFloat(subaccount.notionalValue || 0);
        
        if (equity <= 0) return 0;
        return notionalValue / equity;
    }

    /**
     * Get market data for a specific market
     */
    async getMarketData(market, resolution = '1MIN', limit = 100) {
        const cacheKey = `market_${market}_${resolution}_${limit}`;
        const cached = this.getCachedData(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < 10000) { // 10 second cache
            return cached.data;
        }
        
        const data = await this.client.getCandles(market, resolution, limit);
        this.setCachedData(cacheKey, data, 10000);
        
        return data;
    }

    /**
     * Get funding rate for a market
     */
    async getFundingRate(market) {
        const cacheKey = `funding_${market}`;
        const cached = this.getCachedData(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < 30000) { // 30 second cache
            return cached.data;
        }
        
        const data = await this.client.getFundingRate(market);
        this.setCachedData(cacheKey, data, 30000);
        
        return data;
    }

    /**
     * Cache management
     */
    getCachedData(key) {
        return this.cache.get(key);
    }

    setCachedData(key, data, ttl = 30000) {
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
            ttl
        });
        
        // Clean up expired cache entries
        this.cleanCache();
    }

    cleanCache() {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (now - value.timestamp > value.ttl) {
                this.cache.delete(key);
            }
        }
    }

    clearCache() {
        this.cache.clear();
    }

    /**
     * Subscribe to data updates
     */
    subscribe(event, callback) {
        if (!this.subscribers.has(event)) {
            this.subscribers.set(event, []);
        }
        this.subscribers.get(event).push(callback);
    }

    unsubscribe(event, callback) {
        if (this.subscribers.has(event)) {
            const callbacks = this.subscribers.get(event);
            const index = callbacks.indexOf(callback);
            if (index > -1) {
                callbacks.splice(index, 1);
            }
        }
    }

    notifySubscribers(event, data) {
        if (this.subscribers.has(event)) {
            this.subscribers.get(event).forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    console.error('Subscriber callback error:', error);
                }
            });
        }
    }

    /**
     * Start automatic updates
     */
    startAutoUpdate(address, interval = 10000) {
        this.stopAutoUpdate();
        
        this.updateInterval = setInterval(async () => {
            try {
                const data = await this.loadPortfolioData(address);
                this.notifySubscribers('update', data);
            } catch (error) {
                console.error('Auto-update error:', error);
            }
        }, interval);
    }

    stopAutoUpdate() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
}

// Create default instance
export const dataService = new DataService();