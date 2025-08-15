/**
 * Main Application Controller
 * Orchestrates the entire dashboard application
 */

import { dataService } from './services/data-service.js';
import { ChartManager } from './components/charts.js';
import { TableManager } from './components/tables.js';
import { MetricsDisplay } from './components/metrics.js';
import { formatCurrency, formatPercent, formatNumber } from './utils/formatters.js';

class DashboardApp {
    constructor() {
        this.currentAddress = null;
        this.currentData = null;
        this.components = {};
        this.updateInterval = null;
        
        this.init();
    }

    /**
     * Initialize the application
     */
    async init() {
        console.log('Initializing dYdX Analytics Dashboard v3...');
        
        // Initialize components
        this.initComponents();
        
        // Bind event handlers
        this.bindEvents();
        
        // Check for address in URL
        const urlParams = new URLSearchParams(window.location.search);
        const address = urlParams.get('address');
        
        if (address) {
            await this.loadDashboard(address);
        }
        
        // Initialize keyboard shortcuts
        this.initKeyboardShortcuts();
    }

    /**
     * Initialize UI components
     */
    initComponents() {
        // Initialize chart manager
        this.components.charts = new ChartManager();
        
        // Initialize table manager
        this.components.tables = new TableManager();
        
        // Initialize metrics display
        this.components.metrics = new MetricsDisplay();
        
        console.log('Components initialized');
    }

    /**
     * Bind event handlers
     */
    bindEvents() {
        // Tab navigation
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
        });
        
        // Time selectors
        document.querySelectorAll('.time-option').forEach(option => {
            option.addEventListener('click', (e) => this.changeTimeframe(e.target.textContent));
        });
        
        // Load button
        const loadBtn = document.getElementById('loadDashboard');
        if (loadBtn) {
            loadBtn.addEventListener('click', () => this.handleLoadDashboard());
        }
        
        // Address input enter key
        const addressInput = document.getElementById('addressInput');
        if (addressInput) {
            addressInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.handleLoadDashboard();
            });
        }
        
        // Copy address functionality
        const addressDisplay = document.querySelector('.address');
        if (addressDisplay) {
            addressDisplay.addEventListener('click', () => this.copyAddress());
        }
    }

    /**
     * Initialize keyboard shortcuts
     */
    initKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Command palette
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                this.openCommandPalette();
            }
            
            // Tab navigation with number keys
            if (e.key >= '1' && e.key <= '6') {
                const tabs = ['overview', 'performance', 'risk', 'positions', 'behavior', 'market'];
                if (tabs[parseInt(e.key) - 1]) {
                    this.switchTab(tabs[parseInt(e.key) - 1]);
                }
            }
            
            // Refresh data
            if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                this.refreshData();
            }
        });
    }

    /**
     * Load dashboard for an address
     */
    async loadDashboard(address) {
        try {
            // Show loading state
            this.showLoading(true);
            
            // Update current address
            this.currentAddress = address;
            
            // Update URL
            const url = new URL(window.location);
            url.searchParams.set('address', address);
            window.history.pushState({}, '', url);
            
            // Load data
            const data = await dataService.loadPortfolioData(address);
            this.currentData = data;
            
            // Update all components
            await this.updateAllComponents(data);
            
            // Start auto-update
            this.startAutoUpdate();
            
            // Update address display
            this.updateAddressDisplay(address);
            
            // Hide loading state
            this.showLoading(false);
            
            console.log('Dashboard loaded successfully', data);
            
        } catch (error) {
            console.error('Failed to load dashboard:', error);
            this.showError('Failed to load dashboard: ' + error.message);
            this.showLoading(false);
        }
    }

    /**
     * Update all UI components with new data
     */
    async updateAllComponents(data) {
        // Update metrics
        this.components.metrics.update(data.metrics);
        
        // Update charts
        this.components.charts.updateAll({
            pnl: data.historicalPnl,
            positions: data.positions,
            trades: data.trades,
            funding: data.funding
        });
        
        // Update tables
        this.components.tables.updateAll({
            positions: data.positions,
            trades: data.trades,
            metrics: data.metrics
        });
        
        // Update tab-specific content
        this.updateTabContent(data);
    }

    /**
     * Update tab-specific content
     */
    updateTabContent(data) {
        const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab || 'overview';
        
        switch (activeTab) {
            case 'overview':
                this.updateOverviewTab(data);
                break;
            case 'performance':
                this.updatePerformanceTab(data);
                break;
            case 'risk':
                this.updateRiskTab(data);
                break;
            case 'positions':
                this.updatePositionsTab(data);
                break;
            case 'behavior':
                this.updateBehaviorTab(data);
                break;
            case 'market':
                this.updateMarketTab(data);
                break;
        }
    }

    /**
     * Update Overview tab
     */
    updateOverviewTab(data) {
        // Update primary metrics
        document.getElementById('totalPnL').textContent = formatCurrency(data.metrics.totalPnL);
        document.getElementById('winRate').textContent = formatPercent(data.metrics.winRate);
        document.getElementById('profitFactor').textContent = formatNumber(data.metrics.profitFactor);
        document.getElementById('sharpeRatio').textContent = formatNumber(data.metrics.sharpeRatio);
        document.getElementById('sortinoRatio').textContent = formatNumber(data.metrics.sortinoRatio);
        document.getElementById('maxDrawdown').textContent = formatPercent(data.metrics.maxDrawdown.percentage);
        
        // Update quick stats
        this.updateQuickStats(data);
    }

    /**
     * Switch between tabs
     */
    switchTab(tabName) {
        // Update active tab
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');
        
        // Update content
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(tabName)?.classList.add('active');
        
        // Update breadcrumb
        const breadcrumb = document.querySelector('.breadcrumb');
        if (breadcrumb) {
            breadcrumb.textContent = `ANALYTICS / ${tabName.toUpperCase()}`;
        }
        
        // Load tab-specific data if needed
        if (this.currentData) {
            this.updateTabContent(this.currentData);
        }
    }

    /**
     * Handle load dashboard button click
     */
    handleLoadDashboard() {
        const input = document.getElementById('addressInput');
        const address = input?.value.trim();
        
        if (!address) {
            this.showError('Please enter a valid dYdX address');
            return;
        }
        
        this.loadDashboard(address);
    }

    /**
     * Copy address to clipboard
     */
    copyAddress() {
        if (!this.currentAddress) return;
        
        navigator.clipboard.writeText(this.currentAddress);
        
        const addressEl = document.querySelector('.address');
        const originalText = addressEl.textContent;
        addressEl.textContent = 'Copied!';
        
        setTimeout(() => {
            addressEl.textContent = originalText;
        }, 1500);
    }

    /**
     * Update address display
     */
    updateAddressDisplay(address) {
        const addressEl = document.querySelector('.address');
        if (addressEl) {
            // Shorten address for display
            const shortened = address.slice(0, 8) + '...' + address.slice(-4);
            addressEl.textContent = shortened;
            addressEl.title = address;
        }
    }

    /**
     * Start automatic data updates
     */
    startAutoUpdate() {
        this.stopAutoUpdate();
        
        // Update every 10 seconds
        this.updateInterval = setInterval(() => {
            this.refreshData();
        }, 10000);
        
        // Subscribe to data updates
        dataService.subscribe('update', (data) => {
            this.currentData = data;
            this.updateAllComponents(data);
        });
    }

    /**
     * Stop automatic updates
     */
    stopAutoUpdate() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    /**
     * Refresh data
     */
    async refreshData() {
        if (!this.currentAddress) return;
        
        try {
            const data = await dataService.loadPortfolioData(this.currentAddress);
            this.currentData = data;
            await this.updateAllComponents(data);
            
            // Flash status badge
            const statusBadge = document.querySelector('.status-badge');
            if (statusBadge) {
                statusBadge.style.background = 'var(--warning)';
                setTimeout(() => {
                    statusBadge.style.background = '';
                }, 200);
            }
        } catch (error) {
            console.error('Failed to refresh data:', error);
        }
    }

    /**
     * Change timeframe for charts
     */
    changeTimeframe(timeframe) {
        // Update active timeframe
        document.querySelectorAll('.time-option').forEach(o => o.classList.remove('active'));
        event.target.classList.add('active');
        
        // Update charts based on timeframe
        const days = {
            '1D': 1,
            '7D': 7,
            '30D': 30,
            '90D': 90,
            '1Y': 365,
            'ALL': 9999
        }[timeframe] || 30;
        
        this.components.charts.changeTimeframe(days);
    }

    /**
     * Open command palette
     */
    openCommandPalette() {
        // This would open a command palette UI
        console.log('Command palette would open here');
    }

    /**
     * Show loading state
     */
    showLoading(show) {
        const loader = document.getElementById('loader');
        if (loader) {
            loader.style.display = show ? 'flex' : 'none';
        }
    }

    /**
     * Show error message
     */
    showError(message) {
        const errorEl = document.getElementById('errorMessage');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.style.display = 'block';
            
            setTimeout(() => {
                errorEl.style.display = 'none';
            }, 5000);
        } else {
            console.error(message);
        }
    }

    /**
     * Update quick stats table
     */
    updateQuickStats(data) {
        // Trading Statistics
        document.getElementById('avgWin').textContent = formatCurrency(data.metrics.avgWin);
        document.getElementById('avgLoss').textContent = formatCurrency(data.metrics.avgLoss);
        document.getElementById('riskRewardRatio').textContent = '1:' + formatNumber(data.metrics.riskRewardRatio);
        document.getElementById('expectancy').textContent = formatCurrency(data.metrics.expectancy);
        document.getElementById('recoveryFactor').textContent = formatNumber(data.metrics.recoveryFactor);
        
        // Time Analysis
        document.getElementById('avgWinHoldTime').textContent = this.formatDuration(data.metrics.avgWinHoldTime);
        document.getElementById('avgLossHoldTime').textContent = this.formatDuration(data.metrics.avgLossHoldTime);
    }

    /**
     * Format duration from milliseconds
     */
    formatDuration(ms) {
        if (!ms) return '-';
        
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.app = new DashboardApp();
    });
} else {
    window.app = new DashboardApp();
}

export default DashboardApp;