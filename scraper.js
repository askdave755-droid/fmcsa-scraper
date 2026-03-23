const { OhioSOSScraper, } = require('./sos-scraper');

// Ohio route
app.get('/sos-oh', async (req, res) => {
  try {
    const scraper = new OhioSOSScraper();
    const results = await scraper.scrape(7);
    res.json({ status: 'success', state: 'OH', filings_found: results.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
