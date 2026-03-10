const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');

const app = express();
app.use(express.json());

const INSUREFLOW_API = process.env.INSUREFLOW_API_URL;
const TARGET_STATES = (process.env.TARGET_STATES || 'TX').split(',');

console.log('Starting FMCSA Scraper...');

app.get('/health', (req, res) => {
  res.json({ status: 'ok', api: !!INSUREFLOW_API });
});

app.get('/run', async (req, res) => {
  if (!INSUREFLOW_API) return res.status(500).json({ error: 'API URL not set' });
  
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const carriers = [];
  
  try {
    await page.goto('https://safer.fmcsa.dot.gov/CompanySnapshot.aspx');
    await page.selectOption('select[name="STATE"]', 'TX');
    await page.click('input[type="submit"]');
    await page.waitForTimeout(3000);
    
    const links = await page.$$eval('a[href*="USDOT"]', a => 
      a.map(l => ({url: l.href, dot: l.href.match(/USDOT=(\d+)/)?.[1]})).filter(x => x.dot)
    );
    
    for (const link of links.slice(0, 5)) {
      await page.goto(link.url);
      await page.waitForTimeout(2000);
      const text = await page.evaluate(() => document.body.innerText);
      const phone = (text.match(/(\d{3}-\d{3}-\d{4})/) || [])[1];
      const name = (text.match(/Legal Name:\s*([^\n]+)/) || [])[1]?.trim();
      const units = (text.match(/Power Units:\s*(\d+)/) || [])[1];
      
      if (phone && name && units) {
        carriers.push({ name, phone, units });
        console.log(`Found: ${name}`);
      }
    }
  } catch(e) {
    console.error(e.message);
  }
  
  await browser.close();
  res.json({ success: true, carriers: carriers.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
