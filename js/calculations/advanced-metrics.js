/**
 * Advanced Trading Metrics Calculations
 * Sophisticated metrics for professional trading analysis
 */

/**
 * Calculate mean of an array
 */
function mean(values) {
    if (!values || values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
}

/**
 * Calculate standard deviation
 */
function standardDeviation(values) {
    if (!values || values.length === 0) return 0;
    
    const avg = mean(values);
    const squaredDiffs = values.map(val => Math.pow(val - avg, 2));
    const variance = mean(squaredDiffs);
    
    return Math.sqrt(variance);
}

/**
 * Calculate downside deviation (for Sortino ratio)
 */
function downsideDeviation(returns, targetReturn = 0) {
    if (!returns || returns.length === 0) return 0;
    
    const downsideReturns = returns
        .map(r => Math.min(0, r - targetReturn))
        .map(r => r * r);
    
    return Math.sqrt(mean(downsideReturns));
}

/**
 * Calculate Sharpe Ratio
 * (Return - Risk Free Rate) / Standard Deviation
 */
export function calculateSharpeRatio(returns, riskFreeRate = 0, annualizationFactor = 252) {
    if (!returns || returns.length === 0) return 0;
    
    const avgReturn = mean(returns);
    const stdDev = standardDeviation(returns);
    
    if (stdDev === 0) return 0;
    
    const sharpe = (avgReturn - riskFreeRate) / stdDev;
    
    // Annualize if daily returns
    return sharpe * Math.sqrt(annualizationFactor);
}

/**
 * Calculate Sortino Ratio
 * (Return - Target Return) / Downside Deviation
 */
export function calculateSortinoRatio(returns, targetReturn = 0, annualizationFactor = 252) {
    if (!returns || returns.length === 0) return 0;
    
    const avgReturn = mean(returns);
    const downDev = downsideDeviation(returns, targetReturn);
    
    if (downDev === 0) return avgReturn > targetReturn ? 999 : 0;
    
    const sortino = (avgReturn - targetReturn) / downDev;
    
    // Annualize if daily returns
    return sortino * Math.sqrt(annualizationFactor);
}

/**
 * Calculate Calmar Ratio
 * Annual Return / Max Drawdown
 */
export function calculateCalmarRatio(returns, maxDrawdown, periodsPerYear = 252) {
    if (!returns || returns.length === 0 || maxDrawdown === 0) return 0;
    
    const avgReturn = mean(returns);
    const annualReturn = avgReturn * periodsPerYear;
    
    if (maxDrawdown === 0) return annualReturn > 0 ? 999 : 0;
    
    return Math.abs(annualReturn / maxDrawdown);
}

/**
 * Calculate Kelly Criterion
 * Optimal position size as percentage of capital
 */
export function calculateKellyCriterion(winRate, avgWinRatio, avgLossRatio) {
    if (avgLossRatio === 0) return 0;
    
    const p = winRate / 100; // Convert to decimal
    const q = 1 - p; // Loss rate
    const b = avgWinRatio / avgLossRatio; // Odds
    
    if (b === 0) return 0;
    
    // Kelly formula: (p * b - q) / b
    const kelly = (p * b - q) / b;
    
    // Cap at 25% for safety (full Kelly is often too aggressive)
    return Math.min(Math.max(kelly * 100, 0), 25);
}

/**
 * Calculate Information Ratio
 * (Portfolio Return - Benchmark Return) / Tracking Error
 */
export function calculateInformationRatio(portfolioReturns, benchmarkReturns) {
    if (!portfolioReturns || portfolioReturns.length === 0) return 0;
    
    // Calculate excess returns
    const excessReturns = portfolioReturns.map((ret, i) => {
        const benchmarkRet = benchmarkReturns[i] || 0;
        return ret - benchmarkRet;
    });
    
    const avgExcessReturn = mean(excessReturns);
    const trackingError = standardDeviation(excessReturns);
    
    if (trackingError === 0) return 0;
    
    return avgExcessReturn / trackingError;
}

/**
 * Calculate Omega Ratio
 * Probability weighted ratio of gains vs losses
 */
export function calculateOmegaRatio(returns, threshold = 0) {
    if (!returns || returns.length === 0) return 0;
    
    let sumGains = 0;
    let sumLosses = 0;
    
    returns.forEach(ret => {
        if (ret > threshold) {
            sumGains += (ret - threshold);
        } else {
            sumLosses += (threshold - ret);
        }
    });
    
    if (sumLosses === 0) return sumGains > 0 ? 999 : 0;
    
    return sumGains / sumLosses;
}

/**
 * Calculate Ulcer Index
 * Measures downside volatility
 */
export function calculateUlcerIndex(equityCurve) {
    if (!equityCurve || equityCurve.length === 0) return 0;
    
    let sumSquaredDrawdowns = 0;
    let peak = equityCurve[0];
    
    for (let i = 0; i < equityCurve.length; i++) {
        peak = Math.max(peak, equityCurve[i]);
        const drawdownPct = ((peak - equityCurve[i]) / peak) * 100;
        sumSquaredDrawdowns += drawdownPct * drawdownPct;
    }
    
    return Math.sqrt(sumSquaredDrawdowns / equityCurve.length);
}

/**
 * Calculate Kappa 3 (similar to Sortino but with higher moment)
 */
export function calculateKappa3(returns, threshold = 0) {
    if (!returns || returns.length === 0) return 0;
    
    const avgReturn = mean(returns);
    const lowerPartialMoment3 = calculateLowerPartialMoment(returns, threshold, 3);
    
    if (lowerPartialMoment3 === 0) return 0;
    
    return (avgReturn - threshold) / Math.pow(lowerPartialMoment3, 1/3);
}

/**
 * Calculate Lower Partial Moment
 */
function calculateLowerPartialMoment(returns, threshold, order) {
    if (!returns || returns.length === 0) return 0;
    
    const belowThreshold = returns
        .map(r => Math.max(0, threshold - r))
        .map(r => Math.pow(r, order));
    
    return mean(belowThreshold);
}

/**
 * Calculate Sterling Ratio
 * (Annual Return - Risk Free Rate) / Average Drawdown
 */
export function calculateSterlingRatio(returns, avgDrawdown, riskFreeRate = 0, periodsPerYear = 252) {
    if (!returns || returns.length === 0 || avgDrawdown === 0) return 0;
    
    const avgReturn = mean(returns);
    const annualReturn = avgReturn * periodsPerYear;
    const excessReturn = annualReturn - riskFreeRate;
    
    if (avgDrawdown === 0) return excessReturn > 0 ? 999 : 0;
    
    return Math.abs(excessReturn / avgDrawdown);
}

/**
 * Calculate Burke Ratio
 * Excess return divided by square root of sum of squares of drawdowns
 */
export function calculateBurkeRatio(returns, drawdowns, riskFreeRate = 0) {
    if (!returns || returns.length === 0) return 0;
    
    const avgReturn = mean(returns);
    const excessReturn = avgReturn - riskFreeRate;
    
    const sumSquaredDrawdowns = drawdowns.reduce((sum, dd) => sum + dd * dd, 0);
    const denominator = Math.sqrt(sumSquaredDrawdowns);
    
    if (denominator === 0) return excessReturn > 0 ? 999 : 0;
    
    return excessReturn / denominator;
}

/**
 * Calculate Treynor Ratio
 * (Return - Risk Free Rate) / Beta
 */
export function calculateTreynorRatio(returns, marketReturns, riskFreeRate = 0) {
    if (!returns || returns.length === 0) return 0;
    
    const beta = calculateBeta(returns, marketReturns);
    const avgReturn = mean(returns);
    
    if (beta === 0) return 0;
    
    return (avgReturn - riskFreeRate) / beta;
}

/**
 * Calculate Beta (systematic risk)
 */
export function calculateBeta(returns, marketReturns) {
    if (!returns || !marketReturns || returns.length === 0) return 0;
    
    const avgReturn = mean(returns);
    const avgMarketReturn = mean(marketReturns);
    
    let covariance = 0;
    let marketVariance = 0;
    
    for (let i = 0; i < Math.min(returns.length, marketReturns.length); i++) {
        const returnDiff = returns[i] - avgReturn;
        const marketDiff = marketReturns[i] - avgMarketReturn;
        
        covariance += returnDiff * marketDiff;
        marketVariance += marketDiff * marketDiff;
    }
    
    if (marketVariance === 0) return 0;
    
    return covariance / marketVariance;
}

/**
 * Calculate Alpha (excess return over expected return)
 */
export function calculateAlpha(returns, marketReturns, riskFreeRate = 0) {
    const avgReturn = mean(returns);
    const avgMarketReturn = mean(marketReturns);
    const beta = calculateBeta(returns, marketReturns);
    
    // Jensen's Alpha: Return - (Risk Free + Beta * (Market Return - Risk Free))
    return avgReturn - (riskFreeRate + beta * (avgMarketReturn - riskFreeRate));
}

/**
 * Calculate R-Squared (correlation with market)
 */
export function calculateRSquared(returns, marketReturns) {
    if (!returns || !marketReturns || returns.length === 0) return 0;
    
    const correlation = calculateCorrelation(returns, marketReturns);
    return correlation * correlation;
}

/**
 * Calculate correlation coefficient
 */
function calculateCorrelation(x, y) {
    if (!x || !y || x.length === 0 || y.length === 0) return 0;
    
    const n = Math.min(x.length, y.length);
    const avgX = mean(x.slice(0, n));
    const avgY = mean(y.slice(0, n));
    
    let numerator = 0;
    let denomX = 0;
    let denomY = 0;
    
    for (let i = 0; i < n; i++) {
        const diffX = x[i] - avgX;
        const diffY = y[i] - avgY;
        
        numerator += diffX * diffY;
        denomX += diffX * diffX;
        denomY += diffY * diffY;
    }
    
    const denominator = Math.sqrt(denomX * denomY);
    
    if (denominator === 0) return 0;
    
    return numerator / denominator;
}

/**
 * Calculate Gain to Pain Ratio
 * Sum of returns / Sum of absolute returns
 */
export function calculateGainToPainRatio(returns) {
    if (!returns || returns.length === 0) return 0;
    
    const sumReturns = returns.reduce((sum, r) => sum + r, 0);
    const sumAbsReturns = returns.reduce((sum, r) => sum + Math.abs(r), 0);
    
    if (sumAbsReturns === 0) return 0;
    
    return sumReturns / sumAbsReturns;
}

/**
 * Calculate MAR Ratio (Managed Account Ratio)
 * Compound Annual Growth Rate / Max Drawdown
 */
export function calculateMARRatio(initialCapital, finalCapital, years, maxDrawdown) {
    if (initialCapital <= 0 || years <= 0 || maxDrawdown === 0) return 0;
    
    const cagr = (Math.pow(finalCapital / initialCapital, 1 / years) - 1) * 100;
    
    return Math.abs(cagr / maxDrawdown);
}