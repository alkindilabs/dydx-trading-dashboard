const puppeteer = require('puppeteer');

async function testLiveSite() {
    console.log('Testing live Netlify deployment...\n');
    
    const browser = await puppeteer.launch({
        headless: false,
        slowMo: 100
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Track console messages
    page.on('console', msg => {
        const type = msg.type();
        console.log(`[${type.toUpperCase()}]`, msg.text());
    });
    
    try {
        // Load the Netlify site
        console.log('1. Loading Netlify site...');
        await page.goto('https://glowing-nasturtium-6a670d.netlify.app/', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        console.log('✅ Site loaded\n');
        
        // Check current page title
        const title = await page.title();
        console.log('2. Page title:', title, '\n');
        
        // Check if we have the address input
        console.log('3. Checking for address input...');
        const hasInput = await page.$('#addressInput') !== null;
        
        if (!hasInput) {
            // We might be on the wrong page or it redirected
            console.log('❌ No address input found. Checking URL...');
            const currentUrl = page.url();
            console.log('Current URL:', currentUrl);
            
            // Try to navigate directly to the advanced analytics page
            console.log('\n4. Navigating directly to advanced analytics...');
            await page.goto('https://glowing-nasturtium-6a670d.netlify.app/dydx-advanced-analytics.html', {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
        }
        
        // Check again for input
        const inputExists = await page.$('#addressInput') !== null;
        console.log('Address input exists:', inputExists ? '✅' : '❌');
        
        if (inputExists) {
            // Get current value
            const currentValue = await page.$eval('#addressInput', el => el.value);
            console.log('Current address value:', currentValue || '(empty)');
            
            // Clear and enter test address
            console.log('\n5. Entering test address...');
            await page.click('#addressInput', { clickCount: 3 }); // Select all
            await page.type('#addressInput', 'dydx1redacted');
            console.log('✅ Address entered\n');
            
            // Find and click the button
            console.log('6. Looking for Load Dashboard button...');
            const buttons = await page.$$('button');
            console.log(`Found ${buttons.length} button(s)`);
            
            if (buttons.length > 0) {
                // Click the first button (should be Load Dashboard)
                const buttonText = await buttons[0].evaluate(el => el.textContent);
                console.log(`Clicking button: "${buttonText}"`);
                
                await buttons[0].click();
                console.log('✅ Button clicked\n');
                
                // Wait for potential loading
                console.log('7. Waiting for data to load...');
                await new Promise(r => setTimeout(r, 5000));
                
                // Check if any data loaded
                const metrics = await page.$$eval('.metric-value', elements => 
                    elements.map(el => ({
                        label: el.previousElementSibling?.textContent || 'Unknown',
                        value: el.textContent
                    }))
                );
                
                console.log('8. Metrics found:');
                if (metrics.length > 0) {
                    metrics.slice(0, 5).forEach(m => {
                        console.log(`  ${m.label}: ${m.value}`);
                    });
                } else {
                    console.log('  No metrics found');
                }
                
                // Check for error messages
                const errorElements = await page.$$eval('*', elements => 
                    elements.filter(el => 
                        el.textContent.includes('Failed') || 
                        el.textContent.includes('Error') ||
                        el.textContent.includes('error')
                    ).map(el => el.textContent).slice(0, 3)
                );
                
                if (errorElements.length > 0) {
                    console.log('\n⚠️  Error messages found:');
                    errorElements.forEach(err => console.log('  -', err.substring(0, 100)));
                }
            }
        }
        
        console.log('\n✅ Test completed successfully');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    } finally {
        console.log('\nClosing browser in 5 seconds...');
        await new Promise(r => setTimeout(r, 5000));
        await browser.close();
    }
}

testLiveSite().catch(console.error);