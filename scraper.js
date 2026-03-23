const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');
const { OhioSOSScraper } = require('./sos-scraper');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');

const upload = multer({ dest: 'uploads/' });

const app = express();
app.use(express.json());

const INSUREFLOW_API = process.env.INSUREFLOW_API_URL;
const PORT = process.env.PORT || 8080;

console.log('FMCSA/SOS Scraper Starting...');

let lastRun = null;
let isRunning = false;

app.get('/', (req, res) => {
  res.json({ service: 'FMCSA/SOS Scraper', status: isRunning ? 'scraping' : 'idle', lastRun });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', api: !!INSUREFLOW_API, lastRun, isRunning });
});

// Ohio SOS Auto-Scrape + FastAppend + Vapi
app.get('/sos-oh', async (req, res) => {
  try {
    if (!process.env.FASTAPPEND_API_KEY) {
      return res.status(400).json({ 
        error: 'FastAppend API key not configured',
        message: 'Add FASTAPPEND_API_KEY to Railway environment variables' 
      });
    }
    
    const scraper = new OhioSOSScraper();
    const results = await scraper.scrape(7);
    
    res.json({
      status: 'success',
      state: 'OH',
      filings_found: results.length,
      message: results.length > 0 ? 'Skip tracing and Vapi calls triggered' : 'No new filings found',
      leads: results.map(r => ({ company: r.company, phone: r.phone || 'pending' }))
    });
  } catch (error) {
    console.error('[Route] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// CSV Upload for ANY State (Manual)
app.post('/upload-csv/:state', upload.single('file'), async (req, res) => {
  try {
    const { state } = req.params;
    const results = [];
    
    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        // Clean up file
        fs.unlinkSync(req.file.path);
        
        res.json({
          status: 'success',
          state: state.toUpperCase(),
          uploaded: results.length,
          message: 'CSV received. Process with /process-csv endpoint'
        });
      });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
