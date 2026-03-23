const { chromium } = require('playwright');
const axios = require('axios');

class OhioSOSScraper {
  constructor() {
    this.results = [];
    this.baseUrl = process.env.INSUREFLOW_API_URL || 'http://localhost:8080';
  }

  async scrape(daysBack = 7) {
    console.log(`[SOS-OH] Scraping last ${daysBack} days...`);
    
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
      const page = await browser.newPage();
      
      // Ohio Business Search - easier than TX
      await page.goto('https://businesssearch.ohiosos.gov/', {
        waitUntil: 'networkidle',
        timeout: 60000
      });

      // Search for recent filings
      await page.fill('input[name="SearchTerm"]', 'TRUCKING');
      await page.click('button[type="submit"]');
      
      await page.waitForSelector('table tbody tr', { timeout: 30000 });
      
      const rows = await page.$$('table tbody tr');
      console.log(`[SOS-OH] Found ${rows.length} rows`);
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);
      
      for (const row of rows.slice(0, 20)) {
        const cells = await row.$$('td');
        if (cells.length >= 3) {
          const name = await cells[0].textContent();
          const type = await cells[1].textContent();
          const dateText = await cells[2].textContent();
          
          const filedDate = new Date(dateText.trim());
          
          if (filedDate >= cutoffDate && 
              (name.toLowerCase().includes('truck') || 
               name.toLowerCase().includes('transport'))) {
            
            this.results.push({
              company: name.trim(),
              entity_type: type.trim(),
              filed_date: dateText.trim(),
              state: 'OH',
              source: 'sos_oh',
              insurance_type: 'commercial_auto',
              status: 'new'
            });
          }
        }
      }
      
      console.log(`[SOS-OH] Collected: ${this.results.length}`);
      return this.results;
      
    } catch (error) {
      console.error('[SOS-OH] Error:', error.message);
      return [];
    } finally {
      await browser.close();
    }
  }
}

module.exports = { OhioSOSScraper };
