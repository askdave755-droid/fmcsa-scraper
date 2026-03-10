const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');

const app = express();
app.use(express.json());

const INSUREFLOW_API = process.env.INSUREFLOW_API_URL;

console.log('FMCSA Scraper Starting...');

let lastRun = null;
let isRunning = false;

app.get('/', (req, res) => {
  res.json({ service: 'FMCSA Scraper', status: isRunning ? 'scraping' : 'idle', lastRun });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', api: !!INSUREFLOW_API, lastRun, isRunning });
});

async function doScrape() {
  if (isRunning) return;
  isRunning = true;
  
  const results = [];
  let browser;
  
  try {
    console.log('Launching browser...');
    browser = await chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] 
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 }
    });
    
    const page = await context.newPage();
    
    // Navigate with longer timeout
    console.log('Loading page...');
    await page.goto('https://safer.fmcsa.dot.gov/CompanySnapshot.aspx', { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });
    
    // Wait a bit for any JS to load
    await page.waitForTimeout(3000);
    
    // Log what we see
    const title = await page.title();
    console.log('Page title:', title);
    
    // Try to find the form - FMCSA might have frames or different structure
    const pageContent = await page.content();
    console.log('Page loaded, length:', pageContent.length);
    
    // Check if select exists
    const hasSelect = await page.$('select') !== null;
    console.log('Has select element:', hasSelect);
    
    if (!hasSelect) {
      // Try alternative - maybe need to click something first
      console.log('No select found, saving screenshot...');
      await page.screenshot({ path: '/tmp/debug.png', fullPage: true });
      throw new Error('No form found - FMCSA may be blocking automation');
    }
    
    // Try to select state using evaluate if selectOption fails
    await page.evaluate(() => {
      const select = document.querySelector('select[name="STATE"]') || document.querySelector('select');
      if (select) select.value = 'TX';
    });
    
    await page.click('input[type="submit"]');
    await page.waitForTimeout(5000);
    
    // Get results
    const links = await page.$$eval('a[href*="USDOT"]', 
      a => a.map(l => ({ url: l.href, name: l.textContent.trim() }))
    );
    
    console.log(`Found ${links.length} results`);
    
    // Process first 5
    for (const link of links.slice(0, 5)) {
      try {
        await page.goto(link.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        
        const text = await page.evaluate(() => document.body.innerText);
        const phone = (text.match(/(\d{3}-\d{3}-\d{4})/) || [])[1];
        const name = (text.match(/Legal Name:\s*([^\n]+)/i) || [])[1]?.trim();
        const units = (text.match(/Power Units:\s*(\d+)/i) || [])[1];
        
        if (phone && name && units) {
          console.log(`Found: ${name}`);
          if (INSUREFLOW_API) {
            await axios.post(`${INSUREFLOW_API}/api/leads`, {
              name, company: name, phone: '+1' + phone.replace(/\D/g,''),
              state: 'TX', vehicle_count: parseInt(units),
              insurance_type: 'commercial_auto', source: 'fmcsa_scraper', status: 'new'
            }, { headers: { 'Content-Type': 'application/json' }});
            results.push(name);
          }
        }
      } catch(e) { console.log('Skip:', e.message); }
    }
    
    await context.close();
    lastRun = { time: new Date().toISOString(), count: results.length, carriers: results };
    
  } catch(e) {
    console.error('Fatal error:', e.message);
    lastRun = { error: e.message, time: new Date().toISOString() };
  } finally {
    if (browser) await browser.close();
    isRunning = false;
  }
}

app.get('/run', (req, res) => {
  if (isRunning) return res.json({ status: 'already_running' });
  doScrape();
  res.json({ status: 'started', message: 'Check /health in 3-4 minutes' });
});

app.listen(process.env.PORT || 3000, () => console.log('Running'));
