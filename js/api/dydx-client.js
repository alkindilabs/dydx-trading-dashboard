/**
 * dYdX v4 API Client
 * Handles all communication with the dYdX indexer API
 */

export class DydxClient {
    constructor(baseUrl = 'https://indexer.dydx.trade/v4') {
        this.baseUrl = baseUrl;
        this.cache = new Map();
        this.cacheTimeout = 10000; // 10 seconds
    }

    /**
     * Generic fetch method with error handling and caching
     */
    async fetchEndpoint(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const cacheKey = url + JSON.stringify(options);
        
        // Check cache
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheTimeout) {
                return cached.data;
            }
        }

        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });

            if (!response.ok) {
                throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            
            // Cache the response
            this.cache.set(cacheKey, {
                data,
                timestamp: Date.now()
            });

            return data;
        } catch (error) {
            console.error(`Failed to fetch ${endpoint}:`, error);
            throw error;
        }
    }

    /**
     * Get account information
     */
    async getAccount(address, subaccountNumber = 0) {
        return this.fetchEndpoint(`/addresses/${address}/subaccountNumber/${subaccountNumber}`);
    }

    /**
     * Get all positions for an account
     */
    async getPositions(address, subaccountNumber = 0, status = null) {
        let endpoint = `/perpetualPositions?address=${address}&subaccountNumber=${subaccountNumber}`;
        if (status) {
            endpoint += `&status=${status}`;
        }
        return this.fetchEndpoint(endpoint);
    }

    /**
     * Get fills (trades) for an account
     */
    async getFills(address, subaccountNumber = 0, market = null, limit = 100) {
        let endpoint = `/fills?address=${address}&subaccountNumber=${subaccountNumber}&limit=${limit}`;
        if (market) {
            endpoint += `&market=${market}`;
        }
        return this.fetchEndpoint(endpoint);
    }

    /**
     * Get transfers for an account
     */
    async getTransfers(address, subaccountNumber = 0, limit = 100) {
        return this.fetchEndpoint(
            `/transfers?address=${address}&subaccountNumber=${subaccountNumber}&limit=${limit}`
        );
    }

    /**
     * Get funding payments
     */
    async getFundingPayments(address, subaccountNumber = 0, market = null, limit = 100) {
        let endpoint = `/fundingPayments?address=${address}&subaccountNumber=${subaccountNumber}&limit=${limit}`;
        if (market) {
            endpoint += `&market=${market}`;
        }
        return this.fetchEndpoint(endpoint);
    }

    /**
     * Get historical PnL
     */
    async getHistoricalPnL(address, subaccountNumber = 0, limit = 90) {
        return this.fetchEndpoint(
            `/historical-pnl?address=${address}&subaccountNumber=${subaccountNumber}&limit=${limit}`
        );
    }

    /**
     * Get candles for a market
     */
    async getCandles(market, resolution = '1MIN', limit = 100) {
        return this.fetchEndpoint(
            `/candles/perpetualMarkets/${market}?resolution=${resolution}&limit=${limit}`
        );
    }

    /**
     * Get orderbook for a market
     */
    async getOrderbook(market) {
        return this.fetchEndpoint(`/orderbooks/perpetualMarket/${market}`);
    }

    /**
     * Get funding rate for a market
     */
    async getFundingRate(market) {
        return this.fetchEndpoint(`/perpetualMarkets/${market}`);
    }

    /**
     * Get all markets
     */
    async getMarkets() {
        return this.fetchEndpoint('/perpetualMarkets');
    }

    /**
     * Get market statistics
     */
    async getMarketStats(market, days = 7) {
        return this.fetchEndpoint(`/stats/perpetualMarkets/${market}?days=${days}`);
    }

    /**
     * Get trades for a market
     */
    async getMarketTrades(market, limit = 100) {
        return this.fetchEndpoint(`/trades/perpetualMarket/${market}?limit=${limit}`);
    }

    /**
     * Get aggregated trading rewards
     */
    async getTradingRewards(address, period = 'DAILY') {
        return this.fetchEndpoint(`/rewards/aggregated?address=${address}&period=${period}`);
    }

    /**
     * Batch fetch multiple endpoints
     */
    async batchFetch(requests) {
        return Promise.all(
            requests.map(req => this.fetchEndpoint(req.endpoint, req.options))
        );
    }

    /**
     * Get comprehensive account data (combines multiple endpoints)
     */
    async getComprehensiveAccountData(address, subaccountNumber = 0) {
        try {
            const [account, positions, fills, funding, historicalPnl] = await Promise.all([
                this.getAccount(address, subaccountNumber),
                this.getPositions(address, subaccountNumber),
                this.getFills(address, subaccountNumber, null, 500),
                this.getFundingPayments(address, subaccountNumber, null, 500),
                this.getHistoricalPnL(address, subaccountNumber, 90)
            ]);

            return {
                account,
                positions,
                fills,
                funding,
                historicalPnl,
                timestamp: Date.now()
            };
        } catch (error) {
            console.error('Failed to fetch comprehensive account data:', error);
            throw error;
        }
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.cache.clear();
    }

    /**
     * Set cache timeout
     */
    setCacheTimeout(timeout) {
        this.cacheTimeout = timeout;
    }
}

// Create default instance
export const dydxClient = new DydxClient();