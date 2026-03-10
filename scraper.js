const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');

const app = express();
app.use(express.json());

// Config
const INSUREFLOW_API = 'https://insureflow-ai-production.up.railway.app';
const STATES = ['TX', 'MI', 'OH', 'AL', 'AZ'];

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'scraper_ready', timestamp: new Date().toISOString() });
});

// Manual trigger - scrape all states
app.get('/scrape/all', async (req, res) => {
    res.json({ status: 'scraping_started', states: STATES });
    
    for (const state of STATES) {
        try {
            console.log(`\n🚀 Starting ${state}...`);
            const carriers = await scrapeState(state);
            console.log(`Found ${carriers.length} carriers in ${state}`);
            
            // Send to InsureFlowAI
            for (const carrier of carriers) {
                try {
                    await axios.post(`${INSUREFLOW_API}/api/leads`, carrier);
                    console.log(`✅ Sent: ${carrier.name}`);
                    await sleep(2000); // Rate limit
                } catch (e) {
                    console.error(`Failed to send ${carrier.name}:`, e.message);
                }
            }
        } catch (e) {
            console.error(`${state} failed:`, e.message);
        }
    }
    
    console.log('\n✅ All states complete!');
});

// Scrape single state
app.get('/scrape/:state', async (req, res) => {
    const state = req.params.state.toUpperCase();
    res.json({ status: `scraping_${state}` });
    
    try {
        const carriers = await scrapeState(state);
        
        for (const carrier of carriers) {
            await axios.post(`${INSUREFLOW_API}/api/leads`, carrier);
            await sleep(1500);
        }
        
        console.log(`✅ ${state} done - ${carriers.length} leads sent`);
    } catch (e) {
        console.error(`Scrape error:`, e.message);
    }
});

async function scrapeState(stateCode) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    
    const carriers = [];
    
    try {
        const page = await context.newPage();
        
        // FMCSA Advanced Search URL (allows state filtering)
        const searchUrl = `https://ai.fmcsa.dot.gov/SMS/Tools/Search.aspx`;
        
        await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
        console.log(`Page loaded for ${stateCode}`);
        
        // Select State from dropdown
        await page.selectOption('select[name="ddlState"]', stateCode);
        console.log(`Selected state: ${stateCode}`);
        
        // Click Search
        await page.click('input[name="btnSearch"]');
        await page.waitForLoadState('networkidle');
        console.log('Search executed');
        
        // Wait for results table
        await page.waitForSelector('table#gvCarriers', { timeout: 10000 });
        
        // Extract all rows
        const rows = await page.$$eval('table#gvCarriers tr', rows => {
            return rows.slice(1).map(row => { // Skip header
                const cells = row.querySelectorAll('td');
                return {
                    dot: cells[0]?.textContent?.trim(),
                    legalName: cells[1]?.textContent?.trim(),
                    dba: cells[2]?.textContent?.trim(),
                    city: cells[3]?.textContent?.trim(),
                    state: cells[4]?.textContent?.trim(),
                    status: cells[5]?.textContent?.trim()
                };
            }).filter(r => r.dot && r.status === 'Active');
        });
        
        console.log(`Found ${rows.length} active carriers`);
        
        // Get details for each carrier
        for (const row of rows.slice(0, 20)) { // Limit to 20 per state
            try {
                // Click carrier link for details
                await page.goto(`https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${row.dot}`, {
                    waitUntil: 'networkidle',
                    timeout: 15000
                });
                
                // Extract phone and fleet info
                const details = await page.evaluate(() => {
                    const text = document.body.innerText;
                    
                    // Phone extraction (multiple formats)
                    let phone = text.match(/Phone:\s*[\(]?(\d{3})[\)]?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
                    phone = phone ? phone[0].replace(/[^\d]/g, '').replace(/^1/, '') : null;
                    
                    // Power units
                    const units = text.match(/Power Units:\s*(\d+)/)?.[1] || '0';
                    
                    // Drivers  
                    const drivers = text.match(/Drivers:\s*(\d+)/)?.[1] || '0';
                    
                    // MC Number
                    const mc = text.match(/MC\s*#:\s*(MC-\d+)/)?.[1] || '';
                    
                    return { phone, units: parseInt(units), drivers: parseInt(drivers), mc };
                });
                
                if (details.phone) {
                    carriers.push({
                        name: row.legalName || row.dba || 'Unknown Carrier',
                        phone: '+1' + details.phone,
                        company: row.legalName || row.dba,
                        state: row.state,
                        dot_number: row.dot,
                        mc_number: details.mc,
                        vehicle_count: details.units,
                        driver_count: details.drivers,
                        authority_status: 'Active',
                        source: 'fmcsa_scraper'
                    });
                    console.log(`✓ ${row.legalName}: ${details.phone}`);
                }
                
                await sleep(1000); // Be nice to their server
                
            } catch (e) {
                console.log(`Skip ${row.dot}: ${e.message}`);
            }
        }
        
    } catch (e) {
        console.error(`Scraper error:`, e.message);
    } finally {
        await browser.close();
    }
    
    return carriers;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚛 FMCSA Scraper running on port ${PORT}`);
    console.log(`Target API: ${INSUREFLOW_API}`);
    console.log('Endpoints:');
    console.log(`  GET /scrape/all - Scrape all states`);
    console.log(`  GET /scrape/TX  - Scrape single state`);
});
