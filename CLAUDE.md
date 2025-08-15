# dYdX Trading Dashboard - Development Notes

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