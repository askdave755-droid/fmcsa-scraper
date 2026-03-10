const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');

const app = express();
app.use(express.json());

const INSUREFLOW_API = process.env.INSUREFLOW_API_URL;
const TARGET_STATES = (process.env.TARGET_STATES || 'TX').split(',');

console.log('FMCSA Scraper Starting...');

let lastRun = null;
let isRunning = false;

app.get('/', (req, res) => {
  res.json({
    service: 'FMCSA Scraper',
    endpoints: { health: '/health', run: '/run' },
    status: isRunning ? 'scraping' : 'idle',
    lastRun: lastRun
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', api: !!INSUREFLOW_API, lastRun, isRunning });
});

async function doScrape() {
  if (isRunning) return;
  isRunning = true;
  console.log('Starting scrape job...');
  
  const results = [];
  let browser;
  
  try {
    browser = await chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox'] 
    });
    
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.goto('https://safer.fmcsa.dot.gov/CompanySnapshot.aspx', { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    await page.selectOption('select[name="STATE"]', 'TX');
    await page.click('input[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    
    const links = await page.$$eval('a[href*="USDOT"]', 
      a => a.map(l => ({ url: l.href, dot: l.href.match(/USDOT=(\d+)/)?.[1] }))
           .filter(x => x.dot)
    );
    
    console.log(`Found ${links.length} carriers`);
    
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
          name: get('Legal Name'),
          phone: (text.match(/(\d{3}-\d{3}-\d{4})/) || [])[1],
          usdot: get('USDOT Number').replace(/\D/g,''),
          mcNumber: (text.match(/MC-?(\d+)/) || [])[1],
          state: get('State') || 'TX',
          powerUnits: get('Power Units').replace(/\D/g,'') || '0',
          status: get('Operating Status')
        };
        
        if (carrier.phone && carrier.name && parseInt(carrier.powerUnits) > 0) {
          console.log(`Found: ${carrier.name}`);
          
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
              console.log('Sent to InsureFlow');
            } catch(e) {
              console.log('Send failed:', e.message);
            }
          }
          results.push(carrier);
        }
        await page.waitForTimeout(1000);
      } catch(e) {
        console.log('Skip:', e.message);
      }
    }
    
    await context.close();
    lastRun = { time: new Date().toISOString(), count: results.length, carriers: results.map(c => c.name) };
    console.log(`Done! ${results.length} carriers`);
    
  } catch(e) {
    console.error('Fatal:', e.message);
    lastRun = { error: e.message, time: new Date().toISOString() };
  } finally {
    if (browser) await browser.close();
    isRunning = false;
  }
}

app.get('/run', (req, res) => {
  if (isRunning) return res.json({ status: 'already_running', lastRun });
  doScrape();
  res.json({ status: 'started', message: 'Check /health in 2-3 minutes', lastRun });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Port ${PORT}`));
