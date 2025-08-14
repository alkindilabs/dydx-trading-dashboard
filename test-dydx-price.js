const axios = require('axios');

async function testDydxPrice() {
    console.log('Testing dYdX price API...\n');
    
    try {
        // Test mainnet API
        const mainnetUrl = 'https://indexer.dydx.trade/v4/candles/perpetualMarkets/ETH-USD?resolution=1MIN&limit=1';
        console.log('Fetching from mainnet:', mainnetUrl);
        
        const response = await axios.get(mainnetUrl);
        
        if (response.data && response.data.candles && response.data.candles.length > 0) {
            const candle = response.data.candles[0];
            console.log('\n✅ Success! ETH-USD Price Data:');
            console.log('  Close Price: $' + candle.close);
            console.log('  Open Price: $' + candle.open);
            console.log('  High: $' + candle.high);
            console.log('  Low: $' + candle.low);
            console.log('  Time:', new Date(candle.startedAt).toLocaleString());
            console.log('\nFull candle data:', candle);
        } else {
            console.log('❌ No candle data received');
            console.log('Response:', response.data);
        }
        
        // Compare with old Coingecko API for reference
        console.log('\n--- Comparing with Coingecko ---');
        const coingeckoUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
        const cgResponse = await axios.get(coingeckoUrl);
        console.log('Coingecko ETH price: $' + cgResponse.data.ethereum.usd);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
    }
}

testDydxPrice();