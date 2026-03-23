const { chromium } = require('playwright');
const axios = require('axios');

class TexasSOSScraper {
  constructor() {
    this.results = [];
    this.baseUrl = process.env.BASE_URL || 'http://localhost:8080';
  }

  async scrape(daysBack = 7) {
    console.log(`[SOS-TX] Scraping last ${daysBack} days...`);
    
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    try {
      const page = await context.newPage();
      
      // Texas Comptroller - Taxable Entity Search
      await page.goto('https://mycpa.cpa.state.tx.us/coa/coaSearchForm.html', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Search for trucking-related entities
      await page.selectOption('select[name="searchType"]', 'TaxableEntity');
      await page.fill('input[name="entityName"]', 'TRUCKING');
      
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.click('input[type="submit"][value="Search"]')
      ]);

      // Extract table data
      const rows = await page.$$('table.dataTable tbody tr');
      console.log(`[SOS-TX] Found ${rows.length} rows`);
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);
      
      for (const row of rows.slice(0, 25)) {
        const cells = await row.$$('td');
        if (cells.length >= 4) {
          const name = await cells[0].textContent();
          const type = await cells[1].textContent();
          const date = await cells[2].textContent();
          const status = await cells[3].textContent();
          
          const filedDate = new Date(date.trim());
          
          if (status.includes('Active') && filedDate >= cutoffDate) {
            this.results.push({
              company: name.trim(),
              entity_type: type.trim(),
              filed_date: date.trim(),
              state: 'TX',
              source: 'sos_tx',
              insurance_type: 'commercial_auto',
              naics_code: '484', // Trucking
              status: 'new'
            });
          }
        }
      }
      
      console.log(`[SOS-TX] Collected ${this.results.length} leads`);
      
      // Submit to your InsureFlowAI
      await this.submitToInsureFlow();
      
      return this.results;
      
    } catch (error) {
      console.error('[SOS-TX] Error:', error.message);
      throw error;
    } finally {
      await browser.close();
    }
  }

  async submitToInsureFlow() {
    for (const lead of this.results) {
      try {
        await axios.post(`${this.baseUrl}/api/leads`, lead);
        console.log(`[SOS-TX] Saved: ${lead.company}`);
      } catch (err) {
        console.error(`[SOS-TX] Failed to save ${lead.company}:`, err.message);
      }
    }
  }
}

module.exports = { TexasSOSScraper };
