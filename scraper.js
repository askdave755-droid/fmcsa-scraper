const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');

const app = express();
app.use(express.json());

const INSUREFLOW_API = process.env.INSUREFLOW_API_URL;
const TARGET_STATES = (process.env.TARGET_STATES || 'TX').split(',');

console.log('FMCSA Scraper Starting...');

// Store results in memory (simple tracking)
let lastRun = null;
let isRunning = false;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', api: !!INSUREFLOW_API, lastRun, isRunning });
});

// Non-blocking scrape
async function doScrape() {
  if (isRunning) return;
  isRunning = true;
  console.log('Starting scrape job...');
  
  const results = [];
  let browser;
  
  try {
    browser = await chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    for (const state of TARGET_STATES.slice(0, 1)) { // Just TX for now
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        
        await page.goto('https://safer.fmcsa.dot.gov/CompanySnapshot.aspx', { 
          waitUntil: 'domcontentloaded',
          timeout: 30000 
        });
        
        // Select state and search
        await page.selectOption('select[name="STATE"]', state);
        await page.click('input[type="submit"], button[type="submit"]');
        await page.waitForLoadState('networkidle', { timeout: 30000 });
        
        // Get carrier links
        const links = await page.$$eval('a[href*="USDOT"]', 
          a => a.map(l => ({ url: l.href, dot: l.href.match(/USDOT=(\d+)/)?.[1] }))
               .filter(x => x.dot)
        );
        
        console.log(`Found ${links.length} carriers in ${state}`);
        
        // Scrape first 10 carriers
        for (const link of links.slice(0, 10)) {
          try {
            await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(1500);
            
            const text = await page.evaluate(() => document.body.innerText);
            const get = (label) => {
              const m = text.match(new RegExp(`${label}[:\\s]+([^\\n]+)`, 'i'));
              return m ? m[1].trim() : '';
            };
            
            const carrier = {
              name: get('Legal Name') || get('DBA Name'),
              phone: (text.match(/(\d{3}-\d{3}-\d{4})/) || [])[1],
              usdot: get('USDOT Number').replace(/\D/g,''),
              mcNumber: (text.match(/MC-?(\d+)/) || [])[1],
              state: get('State') || state,
              powerUnits: get('Power Units').replace(/\D/g,'') || '0',
              status: get('Operating Status')
            };
            
            if (carrier.phone && carrier.name && parseInt(carrier.powerUnits) > 0) {
              console.log(`✓ ${carrier.name} (${carrier.powerUnits} units)`);
              
              // Push to InsureFlow
              if (INSUREFLOW_API) {
                try {
                  await axios.post(`${INSUREFLOW_API}/api/leads`, {
                    name: carrier.name,
                    company: carrier.name,
                    phone: '+1' + carrier.phone.replace(/\D/g,''),
                    state: carrier.state,
                    dot_number: carrier.usdot,
                    mc_number: carrier.mcNumber ? `MC-${carrier.mcNumber}` : null,
                    vehicle_count: parseInt(carrier.powerUnits),
                    authority_status: carrier.status,
                    insurance_type: 'commercial_auto',
                    source: 'fmcsa_scraper',
                    status: 'new'
                  }, { 
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000 
                  });
                  console.log(`  → Sent to InsureFlow`);
                } catch(e) {
                  console.log(`  → Failed to send: ${e.message}`);
                }
              }
              
              results.push(carrier);
            }
            
            await page.waitForTimeout(1000); // Rate limit
          } catch(e) {
            console.log(`Skip carrier: ${e.message}`);
          }
        }
        
        await context.close();
      } catch(e) {
        console.error(`State ${state} failed: ${e.message}`);
      }
    }
    
    lastRun = { time: new Date().toISOString(), count: results.length, carriers: results.map(c => c.name) };
    console.log(`✅ Complete! Found ${results.length} carriers`);
    
  } catch(e) {
    console.error('Fatal error:', e.message);
    lastRun = { error: e.message, time: new Date().toISOString() };
  } finally {
    if (browser) await browser.close();
    isRunning = false;
  }
}

// Start scrape in background, return immediately
app.get('/run', (req, res) => {
  if (isRunning) {
    return res.json({ status: 'already_running', lastRun });
  }
  
  // Start scrape in background (don't await)
  doScrape();
  
  res.json({ 
    status: 'started', 
    message: 'Scrape running in background. Check /health for results in 2-3 minutes.',
    lastRun 
  });
});

// Manual trigger with wait (for testing, will timeout)
app.get('/run-wait', async (req, res) => {
  await doScrape();
  res.json(lastRun);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Port ${PORT}`));
