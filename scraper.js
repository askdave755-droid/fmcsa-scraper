const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// Safe env var handling
const INSUREFLOW_API = process.env.INSUREFLOW_API_URL;
const TARGET_STATES = (process.env.TARGET_STATES || 'TX').split(',');
const API_KEY = process.env.INSUREFLOW_API_KEY;

console.log('🚀 FMCSA Scraper Starting...');
console.log('API URL:', INSUREFLOW_API || '⚠️ NOT SET - will fail on scrape');
console.log('States:', TARGET_STATES);

if (!INSUREFLOW_API) {
  console.error('❌ CRITICAL: INSUREFLOW_API_URL not set. Add it in Railway Variables!');
}

// Health check always works even if vars missing
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'fmcsa-scraper',
    api_configured: !!INSUREFLOW_API,
    states: TARGET_STATES,
    timestamp: new Date().toISOString()
  });
});

// Scrape function
async function scrapeFMCSA() {
  if (!INSUREFLOW_API) {
    console.error('Cannot scrape: INSUREFLOW_API_URL not set');
    return { error: 'API URL not configured' };
  }

  console.log('Starting scrape for states:', TARGET_STATES);
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const carriers = [];
  
  try {
    for (const state of TARGET_STATES) {
      console.log(`Scraping ${state}...`);
      // Simplified scraping logic here
      // (Full logic from previous message)
    }
  } catch (err) {
    console.error('Scrape error:', err.message);
  } finally {
    await browser.close();
  }
  
  return { success: true, carriers_found: carriers.length };
}

app.post('/scrape', async (req, res) => {
  res.json({ message: 'Scrape started', check_logs: true });
  scrapeFMCSA().catch(console.error);
});

app.get('/run', async (req, res) => {
  const result = await scrapeFMCSA();
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ API ready on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
