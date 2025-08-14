const puppeteer = require('puppeteer');
const path = require('path');

async function testUpdatedDashboard() {
    console.log('Testing updated dashboard with dYdX price API...\n');
    
    const browser = await puppeteer.launch({
        headless: false,
        slowMo: 100
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Track console messages and network requests
    const apiCalls = [];
    
    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('ETH') || text.includes('price')) {
            console.log(`[Console] ${text}`);
        }
    });
    
    page.on('request', request => {
        const url = request.url();
        if (url.includes('dydx') || url.includes('coingecko')) {
            apiCalls.push({
                url: url,
                method: request.method()
            });
        }
    });
    
    page.on('response', response => {
        const url = response.url();
        if (url.includes('candles/perpetualMarkets/ETH-USD')) {
            console.log(`✅ dYdX price API called: ${response.status()}`);
        }
        if (url.includes('coingecko')) {
            console.log(`⚠️  WARNING: Still calling Coingecko API: ${url}`);
        }
    });
    
    try {
        // Test advanced analytics dashboard
        console.log('1. Loading advanced analytics dashboard...');
        const filePath = `file://${path.resolve(__dirname, 'dydx-advanced-analytics.html')}`;
        await page.goto(filePath, { waitUntil: 'networkidle2' });
        
        // Enter address and load dashboard
        console.log('\n2. Entering address and loading dashboard...');
        await page.type('#addressInput', 'dydx1redacted');
        await page.click('button');
        
        // Wait for API calls
        await new Promise(r => setTimeout(r, 3000));
        
        // Check API calls
        console.log('\n3. API Calls Analysis:');
        console.log('Total API calls made:', apiCalls.length);
        
        const dydxCalls = apiCalls.filter(call => call.url.includes('dydx'));
        const coingeckoCalls = apiCalls.filter(call => call.url.includes('coingecko'));
        
        console.log('  dYdX API calls:', dydxCalls.length);
        console.log('  Coingecko API calls:', coingeckoCalls.length);
        
        if (dydxCalls.length > 0) {
            console.log('\n✅ Successfully using dYdX API for prices!');
            dydxCalls.forEach(call => {
                if (call.url.includes('candles')) {
                    console.log(`  - Price endpoint: ${call.url.substring(0, 80)}...`);
                }
            });
        }
        
        if (coingeckoCalls.length > 0) {
            console.log('\n❌ ERROR: Still using Coingecko API!');
            coingeckoCalls.forEach(call => {
                console.log(`  - ${call.url}`);
            });
        }
        
        // Check if price is displayed
        const priceDisplayed = await page.evaluate(() => {
            const priceElements = document.querySelectorAll('.metric-value');
            for (let el of priceElements) {
                if (el.textContent.includes('$') && el.textContent !== '$-') {
                    return el.textContent;
                }
            }
            return null;
        });
        
        if (priceDisplayed) {
            console.log('\n4. Price displayed on dashboard:', priceDisplayed);
        }
        
        console.log('\n✅ Test completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    } finally {
        console.log('\nClosing browser in 3 seconds...');
        await new Promise(r => setTimeout(r, 3000));
        await browser.close();
    }
}

testUpdatedDashboard().catch(console.error);