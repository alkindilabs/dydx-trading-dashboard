# dYdX Trading Dashboard - Development Notes

## Version History

### v1.0.6-beta (2024-08-15)
- **CRITICAL SECURITY FIXES:**
  - Fixed DOM-based XSS vulnerabilities by replacing innerHTML with safe DOM methods
  - Added input validation and sanitization for URL parameters
  - Added SRI (Subresource Integrity) hashes for all external CDN dependencies
  - Implemented dYdX address format validation
  - Replaced all unsafe innerHTML usages with textContent and createElement
  - Added protection against script injection in user inputs

### v1.0.5-beta (2024-08-15)
- Fixed Risk Analysis tab with proper data display
- Replaced placeholder IDs with correct ones (totalFundingRisk, maxDrawdown, leverageUsed, liquidationPrice)
- Added real calculations for risk metrics:
  - Max drawdown from historical trades
  - Sharpe ratio (simplified calculation)
  - Calmar ratio (return/max drawdown)
  - Leverage calculation
  - Liquidation price estimation
- Made Risk Assessment section dynamic with real data
- Added overall risk score calculation (0-100)
- Added beta disclaimer warning
- Updated index.html to preserve URL parameters when redirecting

### v1.0.4 (2024-08-15)
- Fixed incorrect unrealized P&L display
- Changed element ID from 'totalLosses' to 'unrealizedPnl'
- Now correctly displays unrealized P&L from API data
- Unrealized P&L shows with proper formatting and color (red for negative, green for positive)
- Fixed Total Equity subtitle to show all-time percentage change
- Added P&L breakdown subtitle showing realized and unrealized amounts

### v1.0.3 (2024-08-15)
- Refined Market Exposure chart for better clarity
- Renamed to "Trading Activity by Market"
- Added subtitle explaining the chart purpose
- Improved legend to show percentages
- Enhanced tooltips with P&L and open positions info
- Shows top 5 markets by trade count
- Better color coding for different markets
- Displays "(X trades)" in labels for clarity

### v1.0.2 (2024-08-15)
- Fixed chart reuse error when loading different users
- Added destroyAllCharts() function to properly cleanup before reinitializing
- Charts are now properly destroyed before creating new ones
- Prevents "Canvas is already in use" error

### v1.0.1 (2024-08-15)
- Fixed Free Collateral display (was using wrong ID 'totalVolume')
- Fixed empty Key Insights bullet points with dynamic content
- Improved Market Exposure chart to show trading activity distribution
- Added comprehensive insights based on actual portfolio data
- Created CLAUDE.md for version tracking

### v1.0.0 (2024-08-15)
- Initial release with complete dashboard
- Removed all hardcoded/fake data
- Real-time data from dYdX v4 API only
- Auto-loading from URL parameters
- Tab navigation system
- Multiple analytics views (Overview, Performance, Positions, History, Risk)

## Chart Explanations

### Trading Activity by Market (formerly Market Exposure)
The Trading Activity chart (doughnut chart on Overview tab) shows:
- Distribution of your trades across different markets (ETH-USD, BTC-USD, etc.)
- Each slice size = number of trades in that market
- Labels show market name and trade count
- Legend shows percentage of total trading activity
- Hover tooltip displays:
  - Number of trades and percentage
  - Total P&L for that market
  - Number of open positions
- Shows top 5 most traded markets
- Helps identify trading focus and diversification

## Dashboard Components

### Data Sources
- All price data: dYdX v4 API (`/v4/candles/perpetualMarkets/ETH-USD`)
- Account data: dYdX v4 API (`/v4/addresses/{address}/subaccountNumber/0`)
- Position data: dYdX v4 API (`/v4/perpetualPositions`)

### Key Variables
- `currentPortfolioData`: Stores all portfolio data from API (never pre-initialized)
- `currentAddress`: Currently loaded dYdX address
- `currentETHPrice`: Latest ETH price from dYdX

### Important Rules
1. Never show demo/fake data
2. Always require real dYdX address
3. Display "-" when no data available
4. Auto-load from URL if address parameter present

## Future Improvements
- Add more detailed error messages
- Implement data caching for performance
- Add export functionality for reports
- Support for multiple subaccounts