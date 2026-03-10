const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const INSUREFLOW_API = process.env.INSUREFLOW_API_URL;
const TARGET_STATES = (process.env.TARGET_STATES || 'TX').split(',');

console.log('FMCSA Scraper Starting...');
console.log('API:', INSUREFLOW_API || 'NOT SET');

app.get('/health', (req, res) => {
  res.json({ status: 'ok', api_configured: !!INSUREFLOW_API });
});

const delay = ms => new Promise(r => setTimeout(r, ms));

async function scrapeState(state) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const carriers = [];
  
  try {
    await page.goto('https://safer.fmcsa.dot.gov/CompanySnapshot.aspx', { waitUntil: 'domcontentloaded' });
    await page.selectOption('select[name="STATE"]', state);
    await page.click('input[type="submit"]');
    await page.waitForLoadState('networkidle');
    
    const links = await page.$$eval('a[href*="USDOT"]', a => a.map(l => ({url: l.href, dot: l.href.match(/USDOT=(\d+)/)?.[1]})).filter(x => x.dot));
    
    for (const link of links.slice(0, 25)) {
      try {
        await delay(2000);
        await page.goto(link.url, { waitUntil: 'domcontentloaded' });
        const text = await page.evaluate(() => document.body.innerText);
        const get = label => (text.match(new RegExp(`${label}[:\\s]+([^\\n]+)`, 'i')) || [])[1]?.trim() || '';
        
        const carrier = {
          legalName: get('Legal Name'),
          phone: (text.match(/(\d{3}-\d{3}-\d{4})/) || [])[1] || '',
          usdot: get('USDOT Number').replace(/\D/g,''),
          mcNumber: (text.match(/MC-?(\d+)/) || [])[1] || '',
          state: get('State'),
          powerUnits: get('Power Units').replace(/\D/g,'') || '0',
          status: get('Operating Status')
        };
        
        if (carrier.usdot && carrier.phone && parseInt(carrier.powerUnits) > 0) {
          carriers.push(carrier);
          console.log(`[${state}] ${carrier.legalName}`);
          
          await axios.post(`${INSUREFLOW_API}/api/leads`, {
            name: carrier.legalName,
            company: carrier.legalName,
            phone: '+1' + carrier.phone.replace(/\D/g,''),
            state: carrier.state || state,
            dot_number: carrier.usdot,
            mc_number: carrier.mcNumber ? `MC-${carrier.mcNumber}` : null,
            vehicle_count: parseInt(carrier.powerUnits),
            insurance_type: 'commercial_auto',
            source: 'fmcsa_scraper',
            status: 'new'
          }, { headers: { 'Content-Type': 'application/json' }});
        }
      } catch(e) { console.log('Skip:', e.message); }
    }
  } catch(e) { console.error('Error:', e.message); }
  
  await browser.close();
  return carriers;
}

app.get('/run', async (req, res) => {
  if (!INSUREFLOW_API) return res.status(500).json({ error: 'API URL not set' });
  const results = [];
  for (const state of TARGET_STATES) {
    results.push(...await scrapeState(state.trim()));
  }
  res.json({ success: true, count: results.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Port ${PORT}`));
