# dYdX Trading Dashboard - Development Notes

## Version History

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

### Market Exposure
The Market Exposure chart (doughnut chart on Overview tab) shows:
- Distribution of trading activity across different markets (ETH-USD, BTC-USD, etc.)
- Each segment represents the number of trades in that market
- Helps visualize portfolio diversification and market focus
- Shows "No Trading Data" when there are no positions

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