/**
 * Risk Metrics Calculations
 * Advanced risk analysis for trading portfolios
 */

/**
 * Calculate maximum drawdown from equity curve
 */
export function calculateMaxDrawdown(equityCurve) {
    if (!equityCurve || equityCurve.length === 0) return { value: 0, percentage: 0, duration: 0 };
    
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;
    let peak = equityCurve[0];
    let peakIndex = 0;
    let troughIndex = 0;
    let maxDuration = 0;
    let currentDuration = 0;
    let drawdownStart = 0;
    
    for (let i = 0; i < equityCurve.length; i++) {
        const value = typeof equityCurve[i] === 'object' ? equityCurve[i].equity : equityCurve[i];
        
        if (value > peak) {
            peak = value;
            peakIndex = i;
            currentDuration = 0;
            drawdownStart = i;
        } else {
            currentDuration = i - drawdownStart;
            const drawdown = peak - value;
            const drawdownPct = (drawdown / peak) * 100;
            
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
                maxDrawdownPct = drawdownPct;
                troughIndex = i;
                maxDuration = currentDuration;
            }
        }
    }
    
    return {
        value: maxDrawdown,
        percentage: maxDrawdownPct,
        duration: maxDuration,
        peakIndex,
        troughIndex
    };
}

/**
 * Calculate all drawdown periods
 */
export function calculateDrawdownPeriods(equityCurve, threshold = 0) {
    if (!equityCurve || equityCurve.length === 0) return [];
    
    const drawdowns = [];
    let peak = equityCurve[0];
    let inDrawdown = false;
    let drawdownStart = 0;
    let currentDrawdown = {
        startIndex: 0,
        endIndex: 0,
        peakValue: 0,
        troughValue: 0,
        depth: 0,
        depthPct: 0,
        duration: 0,
        recovery: 0
    };
    
    for (let i = 0; i < equityCurve.length; i++) {
        const value = typeof equityCurve[i] === 'object' ? equityCurve[i].equity : equityCurve[i];
        
        if (value >= peak) {
            if (inDrawdown) {
                // Drawdown ended
                currentDrawdown.endIndex = i;
                currentDrawdown.recovery = i - currentDrawdown.startIndex - currentDrawdown.duration;
                if (currentDrawdown.depthPct > threshold) {
                    drawdowns.push({...currentDrawdown});
                }
                inDrawdown = false;
            }
            peak = value;
        } else {
            const drawdownPct = ((peak - value) / peak) * 100;
            
            if (!inDrawdown) {
                // New drawdown started
                inDrawdown = true;
                drawdownStart = i - 1;
                currentDrawdown = {
                    startIndex: drawdownStart,
                    endIndex: i,
                    peakValue: peak,
                    troughValue: value,
                    depth: peak - value,
                    depthPct: drawdownPct,
                    duration: 1,
                    recovery: 0
                };
            } else {
                // Update current drawdown
                if (value < currentDrawdown.troughValue) {
                    currentDrawdown.troughValue = value;
                    currentDrawdown.depth = peak - value;
                    currentDrawdown.depthPct = drawdownPct;
                }
                currentDrawdown.duration = i - drawdownStart;
            }
        }
    }
    
    // Add last drawdown if still in one
    if (inDrawdown && currentDrawdown.depthPct > threshold) {
        drawdowns.push(currentDrawdown);
    }
    
    return drawdowns;
}

/**
 * Calculate Value at Risk (VaR)
 * The maximum expected loss at a given confidence level
 */
export function calculateVaR(returns, confidence = 0.95, method = 'historical') {
    if (!returns || returns.length === 0) return 0;
    
    switch (method) {
        case 'historical':
            return historicalVaR(returns, confidence);
        case 'parametric':
            return parametricVaR(returns, confidence);
        case 'montecarlo':
            return monteCarloVaR(returns, confidence);
        default:
            return historicalVaR(returns, confidence);
    }
}

/**
 * Historical VaR calculation
 */
function historicalVaR(returns, confidence) {
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const index = Math.floor((1 - confidence) * sortedReturns.length);
    return Math.abs(sortedReturns[index] || 0);
}

/**
 * Parametric VaR calculation (assumes normal distribution)
 */
function parametricVaR(returns, confidence) {
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    // Z-score for confidence level (approximate)
    const zScore = getZScore(confidence);
    
    return Math.abs(mean - zScore * stdDev);
}

/**
 * Monte Carlo VaR calculation
 */
function monteCarloVaR(returns, confidence, simulations = 10000) {
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    const simulatedReturns = [];
    for (let i = 0; i < simulations; i++) {
        // Generate random return using normal distribution
        const randomReturn = generateNormalRandom(mean, stdDev);
        simulatedReturns.push(randomReturn);
    }
    
    return historicalVaR(simulatedReturns, confidence);
}

/**
 * Calculate Conditional Value at Risk (CVaR / Expected Shortfall)
 * The expected loss beyond VaR
 */
export function calculateCVaR(returns, confidence = 0.95) {
    if (!returns || returns.length === 0) return 0;
    
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const varIndex = Math.floor((1 - confidence) * sortedReturns.length);
    
    // Calculate average of returns worse than VaR
    let sum = 0;
    let count = 0;
    
    for (let i = 0; i <= varIndex; i++) {
        sum += sortedReturns[i];
        count++;
    }
    
    return count > 0 ? Math.abs(sum / count) : 0;
}

/**
 * Calculate portfolio beta against market
 */
export function calculatePortfolioBeta(portfolioReturns, marketReturns) {
    if (!portfolioReturns || !marketReturns || portfolioReturns.length === 0) return 0;
    
    const n = Math.min(portfolioReturns.length, marketReturns.length);
    
    // Calculate means
    let portfolioMean = 0;
    let marketMean = 0;
    for (let i = 0; i < n; i++) {
        portfolioMean += portfolioReturns[i];
        marketMean += marketReturns[i];
    }
    portfolioMean /= n;
    marketMean /= n;
    
    // Calculate covariance and market variance
    let covariance = 0;
    let marketVariance = 0;
    
    for (let i = 0; i < n; i++) {
        const portfolioDiff = portfolioReturns[i] - portfolioMean;
        const marketDiff = marketReturns[i] - marketMean;
        
        covariance += portfolioDiff * marketDiff;
        marketVariance += marketDiff * marketDiff;
    }
    
    if (marketVariance === 0) return 0;
    
    return covariance / marketVariance;
}

/**
 * Calculate liquidation price for a position
 */
export function calculateLiquidationPrice(position) {
    const { side, entryPrice, size, leverage, maintenanceMargin = 0.006 } = position;
    
    if (!entryPrice || !size || !leverage) return 0;
    
    const initialMargin = 1 / leverage;
    const liquidationDistance = initialMargin - maintenanceMargin;
    
    if (side === 'LONG') {
        return entryPrice * (1 - liquidationDistance);
    } else {
        return entryPrice * (1 + liquidationDistance);
    }
}

/**
 * Calculate distance to liquidation
 */
export function calculateLiquidationDistance(position, currentPrice) {
    const liquidationPrice = calculateLiquidationPrice(position);
    
    if (!liquidationPrice || !currentPrice) return 0;
    
    if (position.side === 'LONG') {
        return ((currentPrice - liquidationPrice) / currentPrice) * 100;
    } else {
        return ((liquidationPrice - currentPrice) / currentPrice) * 100;
    }
}

/**
 * Calculate portfolio volatility
 */
export function calculateVolatility(returns, annualizationFactor = 252) {
    if (!returns || returns.length === 0) return 0;
    
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const dailyVol = Math.sqrt(variance);
    
    // Annualize the volatility
    return dailyVol * Math.sqrt(annualizationFactor);
}

/**
 * Calculate skewness (asymmetry of returns distribution)
 */
export function calculateSkewness(returns) {
    if (!returns || returns.length < 3) return 0;
    
    const n = returns.length;
    const mean = returns.reduce((sum, r) => sum + r, 0) / n;
    
    let m2 = 0; // Second moment
    let m3 = 0; // Third moment
    
    for (const r of returns) {
        const diff = r - mean;
        m2 += diff * diff;
        m3 += diff * diff * diff;
    }
    
    m2 = m2 / n;
    m3 = m3 / n;
    
    const stdDev = Math.sqrt(m2);
    
    if (stdDev === 0) return 0;
    
    return m3 / Math.pow(stdDev, 3);
}

/**
 * Calculate kurtosis (tail risk measure)
 */
export function calculateKurtosis(returns) {
    if (!returns || returns.length < 4) return 0;
    
    const n = returns.length;
    const mean = returns.reduce((sum, r) => sum + r, 0) / n;
    
    let m2 = 0; // Second moment
    let m4 = 0; // Fourth moment
    
    for (const r of returns) {
        const diff = r - mean;
        m2 += diff * diff;
        m4 += diff * diff * diff * diff;
    }
    
    m2 = m2 / n;
    m4 = m4 / n;
    
    const variance = m2;
    
    if (variance === 0) return 0;
    
    return (m4 / (variance * variance)) - 3; // Excess kurtosis
}

/**
 * Calculate tail ratio (right tail / left tail)
 */
export function calculateTailRatio(returns, percentile = 0.05) {
    if (!returns || returns.length === 0) return 0;
    
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const n = sortedReturns.length;
    
    const leftIndex = Math.floor(n * percentile);
    const rightIndex = Math.floor(n * (1 - percentile));
    
    const leftTail = Math.abs(sortedReturns[leftIndex] || 0);
    const rightTail = Math.abs(sortedReturns[rightIndex] || 0);
    
    if (leftTail === 0) return rightTail > 0 ? 999 : 0;
    
    return rightTail / leftTail;
}

/**
 * Helper function to get Z-score for confidence level
 */
function getZScore(confidence) {
    // Approximate Z-scores for common confidence levels
    const zScores = {
        0.90: 1.282,
        0.95: 1.645,
        0.99: 2.326
    };
    
    return zScores[confidence] || 1.645;
}

/**
 * Generate random number from normal distribution
 */
function generateNormalRandom(mean, stdDev) {
    // Box-Muller transform
    let u = 0, v = 0;
    while (u === 0) u = Math.random(); // Converting [0,1) to (0,1)
    while (v === 0) v = Math.random();
    
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return z * stdDev + mean;
}

/**
 * Calculate risk-adjusted return
 */
export function calculateRiskAdjustedReturn(returns, riskMeasure = 'volatility') {
    if (!returns || returns.length === 0) return 0;
    
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    let risk = 0;
    
    switch (riskMeasure) {
        case 'volatility':
            risk = calculateVolatility(returns, 1); // Daily volatility
            break;
        case 'var':
            risk = calculateVaR(returns, 0.95);
            break;
        case 'cvar':
            risk = calculateCVaR(returns, 0.95);
            break;
        default:
            risk = calculateVolatility(returns, 1);
    }
    
    if (risk === 0) return avgReturn > 0 ? 999 : 0;
    
    return avgReturn / risk;
}