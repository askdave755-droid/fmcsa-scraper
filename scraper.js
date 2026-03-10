const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const INSUREFLOW_API = process.env.INSUREFLOW_API_URL;
const TARGET_STATES = (process.env.TARGET_STATES || 'TX').split(',');
const API_KEY = process.env.INSUREFLOW_API_KEY;
const RATE_LIMIT = 2000;

console.log('🚀 FMCSA Scraper Starting...');

if (!INSUREFLOW_API) {
  console.error('❌ CRITICAL: INSUREFLOW_API_URL not set!');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeState(browser, state) {
  console.log(`[${state}] Scraping...`);
  const carriers = [];
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();

  try {
    await page.goto('https://safer.fmcsa.dot.gov/CompanySnapshot.aspx', { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });
    
    await page.selectOption('select[name="STATE"]', state);
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForLoadState('networkidle');
    
    const rows = await page.$$eval('table tr', rows => {
      return rows.map(row => {
        const link = row.querySelector('a[href*="USDOT"]');
        return link ? { url: link.href, dot: link.href.match(/USDOT=(\d+)/)?.[1] } : null;
      }).filter(x => x);
    });

    console.log(`[${state}] Found ${rows.length} carriers`);

    for (const row of rows.slice(0, 25)) {
      try {
        await delay(RATE_LIMIT);
        await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        
        const details = await page.evaluate(() => {
          const text = document.body.innerText;
          const get = (label) => {
            const m = text.match(new RegExp(`${label}[:\\\\s]+([^\\\\n]+)`, 'i'));
            return m ? m[1].trim() : '';
          };
          return {
            legalName: get('Legal Name'),
            phone: (text.match(/(\\d{3}-\\d{3}-\\d{4})/) || [])[1] || '',
            usdot: get('USDOT Number').replace(/\\\\D/g,''),
            mcNumber: (text.match(/MC-?(\\d+)/) || [])[1] || '',
            state: get('State'),
            powerUnits: get('Power Units').replace(/\\\\D/g,'') || '0',
            drivers: get('Drivers').replace(/\\\\D/g,'') || '0',
            status: get('Operating Status')
          };
        });

        if (details.usdot && details.phone && parseInt(details.powerUnits) > 0) {
          carriers.push(details);
          console.log(`[${state}] ✓ ${details.legalName} (${details.powerUnits} units)`);
        }
      } catch(e) {
        console.log(`[${state}] Skip: ${e.message}`);
      }
    }
  } catch(e) {
    console.error(`[${state}] Error: ${e.message}`);
  }
  
  await context.close();
  return carriers;
}

async function pushCarrier(carrier) {
  try {
    const phone = '+1' + carrier.phone.replace(/\\\\D/g,'');
    const lead = {
      name: carrier.legalName || 'Fleet Owner',
      company: carrier.legalName,
      phone: phone,
      state: carrier.state || 'TX',
      dot_number: carrier.usdot,
      mc_number: carrier.mcNumber ? `MC-${carrier.mcNumber}` : null,
      vehicle_count: parseInt(carrier.powerUnits) || 0,
      driver_count: parseInt(carrier.drivers) || 0,
      authority_status: carrier.status,
      insurance_type: 'commercial_auto',
      source: 'fmcsa_scraper',
      status: 'new'
    };
    
    const res = await axios.post(`${INSUREFLOW_API}/api/leads`, lead, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log(`✓ Sent: ${carrier.legalName}`);
    return res.data;
  } catch(e) {
    console.error(`✗ Failed: ${e.response?.status || e.message}`);
    return null;
  }
}

async function runScrape() {
  if (!INSUREFLOW_API) return { error: 'API URL not set' };
  
  console.log('Starting scrape...');
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  let total = 0;
  for (const state of TARGET_STATES) {
    const carriers = await scrapeState(browser, state.trim());
    total += carriers.length;
    for (const c of carriers) {
      await pushCarrier(c);
      await delay(500);
    }
  }
  
  await browser.close();
  console.log(`✅ Done! Sent ${total} carriers`);
  return { success: true, count: total };
}

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    api_configured: !!INSUREFLOW_API,
    states: TARGET_STATES
  });
});

app.get('/run', async (req, res) => {
  const result = await runScrape();
  res.json(result);
});

app.post('/scrape', (req, res) => {
  res.json({ started: true });
  runScrape().catch(console.error);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ API ready on port ${PORT}`);
});
