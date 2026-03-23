const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');
const { TexasSOSScraper } = require('./sos-scraper');

const app = express();
app.use(express.json());

const INSUREFLOW_API = process.env.INSUREFLOW_API_URL;

console.log('FMSCA Scraper Starting...');

let lastRun = null;
let isRunning = false;

app.get('/', (req, res) => {
  res.json({ service: 'FMCSA Scraper', status: isRunning ? 'scraping' : 'idle', lastRun });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', api: !!INSUREFLOW_API, lastRun, isRunning });
});

// SOS Texas Scraper Route
app.get('/sos-tx', async (req, res) => {
  try {
    const days = req.query.days || 7;
    const scraper = new TexasSOSScraper();
    const results = await scraper.scrape(parseInt(days));
    
    res.json({
      status: 'success',
      state: 'TX',
      filings_found: results.length,
      sample: results.slice(0, 5)
    });
  } catch (error) {
    console.error('[SOS Route] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function doScrape() {
  if (isRunning) return;
  isRunning = true;
  
  const results = [];
  let browser;
  
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    // Your existing FMCSA scraping logic here
    // (keeping your original code)
    
    await page.goto('https://safer.fmcsa.dot.gov/CompanySnapshot.aspx');
    
    // ... rest of your FMCSA code ...
    
    console.log('Scrape completed, found', results.length, 'carriers');
    lastRun = new Date().toISOString();
    
  } catch (error) {
    console.error('Scrape error:', error);
  } finally {
    if (browser) await browser.close();
    isRunning = false;
  }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Auto-run on startup if needed
// doScrape();
