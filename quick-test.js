const puppeteer = require('puppeteer');
const path = require('path');

async function quickTest() {
    console.log('Quick dashboard test...\n');
    
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Capture console errors
    const errors = [];
    page.on('console', msg => {
        if (msg.type() === 'error') {
            errors.push(msg.text());
        }
    });
    
    page.on('pageerror', error => {
        errors.push(error.message);
    });
    
    try {
        // Load local file
        const filePath = `file://${path.resolve(__dirname, 'dydx-advanced-analytics.html')}`;
        await page.goto(filePath, { waitUntil: 'domcontentloaded' });
        
        // Check if loadDashboardFromInput function exists
        const functionExists = await page.evaluate(() => {
            return typeof loadDashboardFromInput !== 'undefined';
        });
        
        console.log('loadDashboardFromInput exists:', functionExists);
        
        // Check for any immediate errors
        console.log('\nJavaScript errors found:', errors.length);
        errors.forEach(err => console.log('  -', err));
        
        // Check if the script tag loaded correctly
        const scriptContent = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            const mainScript = scripts.find(s => s.textContent.includes('loadDashboardFromInput'));
            return mainScript ? 'Found main script' : 'Main script not found';
        });
        
        console.log('\nScript status:', scriptContent);
        
        // Try to get the actual function definition
        const functionDefined = await page.evaluate(() => {
            return window.loadDashboardFromInput ? 'Function is in window scope' : 'Function not in window scope';
        });
        
        console.log('Function scope:', functionDefined);
        
    } catch (error) {
        console.error('Test error:', error.message);
    } finally {
        await browser.close();
    }
}

quickTest().catch(console.error);