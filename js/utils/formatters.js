/**
 * Formatting Utilities
 * Consistent formatting for numbers, currencies, dates, etc.
 */

/**
 * Format currency values
 */
export function formatCurrency(value, decimals = 2, includeSign = true) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    
    const absValue = Math.abs(value);
    const sign = value >= 0 ? '+' : '-';
    
    const formatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    }).format(absValue);
    
    return includeSign && value !== 0 ? sign + formatted : formatted;
}

/**
 * Format percentage values
 */
export function formatPercent(value, decimals = 2, includeSign = false) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    
    const sign = value >= 0 ? '+' : '';
    const formatted = value.toFixed(decimals) + '%';
    
    return includeSign ? sign + formatted : formatted;
}

/**
 * Format number values
 */
export function formatNumber(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    
    if (value >= 999) return '999+';
    
    return value.toFixed(decimals);
}

/**
 * Format large numbers with abbreviations
 */
export function formatLargeNumber(value) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    
    const absValue = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    
    if (absValue >= 1e9) {
        return sign + (absValue / 1e9).toFixed(2) + 'B';
    } else if (absValue >= 1e6) {
        return sign + (absValue / 1e6).toFixed(2) + 'M';
    } else if (absValue >= 1e3) {
        return sign + (absValue / 1e3).toFixed(2) + 'K';
    } else {
        return sign + absValue.toFixed(2);
    }
}

/**
 * Format date/time
 */
export function formatDateTime(dateString, format = 'short') {
    if (!dateString) return '-';
    
    const date = new Date(dateString);
    
    if (isNaN(date.getTime())) return '-';
    
    switch (format) {
        case 'short':
            return date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric'
            });
        case 'medium':
            return date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        case 'long':
            return date.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        case 'time':
            return date.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit'
            });
        case 'relative':
            return formatRelativeTime(date);
        default:
            return date.toLocaleDateString();
    }
}

/**
 * Format relative time
 */
export function formatRelativeTime(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    
    if (diffSec < 60) {
        return 'Just now';
    } else if (diffMin < 60) {
        return `${diffMin}m ago`;
    } else if (diffHour < 24) {
        return `${diffHour}h ago`;
    } else if (diffDay < 7) {
        return `${diffDay}d ago`;
    } else {
        return formatDateTime(date, 'short');
    }
}

/**
 * Format duration
 */
export function formatDuration(milliseconds) {
    if (!milliseconds || milliseconds <= 0) return '-';
    
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
        return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

/**
 * Format address (shortened)
 */
export function formatAddress(address, length = 8) {
    if (!address) return '-';
    
    if (address.length <= length * 2) return address;
    
    const start = address.slice(0, length);
    const end = address.slice(-4);
    
    return `${start}...${end}`;
}

/**
 * Format market name
 */
export function formatMarket(market) {
    if (!market) return '-';
    
    // Remove -USD suffix for cleaner display
    return market.replace('-USD', '');
}

/**
 * Format side (LONG/SHORT)
 */
export function formatSide(side) {
    if (!side) return '-';
    
    return side.toUpperCase();
}

/**
 * Format leverage
 */
export function formatLeverage(leverage) {
    if (!leverage || leverage <= 0) return '-';
    
    return leverage.toFixed(1) + 'x';
}

/**
 * Format basis points
 */
export function formatBps(value) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    
    // Convert to basis points (1% = 100 bps)
    const bps = value * 10000;
    
    return bps.toFixed(1) + ' bps';
}

/**
 * Format ratio
 */
export function formatRatio(numerator, denominator) {
    if (!denominator || denominator === 0) return '-';
    
    const ratio = numerator / denominator;
    
    if (ratio >= 1) {
        return `${ratio.toFixed(2)}:1`;
    } else {
        return `1:${(1 / ratio).toFixed(2)}`;
    }
}

/**
 * Get color class based on value
 */
export function getColorClass(value, type = 'pnl') {
    if (value === null || value === undefined) return '';
    
    switch (type) {
        case 'pnl':
        case 'return':
            return value > 0 ? 'profit' : value < 0 ? 'loss' : '';
        case 'risk':
            return value > 70 ? 'loss' : value > 40 ? 'warning' : 'profit';
        case 'leverage':
            return value > 5 ? 'loss' : value > 3 ? 'warning' : '';
        default:
            return '';
    }
}

/**
 * Format table data based on column type
 */
export function formatTableCell(value, columnType) {
    switch (columnType) {
        case 'currency':
            return formatCurrency(value);
        case 'percent':
            return formatPercent(value);
        case 'number':
            return formatNumber(value);
        case 'datetime':
            return formatDateTime(value);
        case 'duration':
            return formatDuration(value);
        case 'address':
            return formatAddress(value);
        case 'market':
            return formatMarket(value);
        case 'side':
            return formatSide(value);
        case 'leverage':
            return formatLeverage(value);
        default:
            return value || '-';
    }
}