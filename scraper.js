const { chromium } = require('playwright');
const axios = require('axios');

class TexasSOSScraper {
  constructor() {
    this.results = [];
    this.baseUrl = process.env.INSUREFLOW_API_URL || 'http://localhost:8080';
  }

  async scrape(daysBack = 7) {
    console.log(`[SOS-TX] Starting scrape for last ${daysBack} days...`);
    
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    try {
      const page = await context.newPage();
      
      // Texas Comptroller - Try the direct search URL first
      console.log('[SOS-TX] Navigating to search page...');
      
      // Alternative 1: Direct search with query params
      const searchUrl = 'https://mycpa.cpa.state.tx.us/coa/coaSearchResults.html?searchType=TaxableEntity&entityName=TRUCKING&submit=Search';
      
      await page.goto(searchUrl, {
        waitUntil: 'networkidle',
        timeout: 60000
      });

      console.log('[SOS-TX] Page loaded, waiting for results...');
      
      // Wait for results table with multiple strategies
      await page.waitForSelector('table.dataTable, table[class*="table"], tbody tr', { 
        timeout: 30000,
        state: 'visible'
      });

      // Extract data from any table found
      const rows = await page.$$('table tbody tr');
      console.log(`[SOS-TX] Found ${rows.length} rows`);
      
      if (rows.length === 0) {
        console.log('[SOS-TX] No rows found, trying alternative selector...');
        // Try alternative selectors
        const altRows = await page.$$('tr');
        console.log(`[SOS-TX] Alternative search found ${altRows.length} rows`);
      }
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);
      
      for (const row of rows.slice(0, 25)) {
        try {
          const cells = await row.$$('td');
          if (cells.length >= 3) {
            const name = await cells[0].textContent();
            const type = await cells[1].textContent();
            const date = await cells[2].textContent();
            const status = cells[3] ? await cells[3].textContent() : 'Active';
            
            // Clean up the data
            const cleanName = name.trim();
            const cleanDate = date.trim();
            
            // Parse date (handle multiple formats)
            let filedDate;
            try {
              filedDate = new Date(cleanDate);
            } catch(e) {
              continue;
            }
            
            // Filter: Active, recent, trucking-related
            if ((status.includes('Active') || status.includes('Exist')) && 
                filedDate >= cutoffDate &&
                (cleanName.toLowerCase().includes('truck') || 
                 cleanName.toLowerCase().includes('transport') ||
                 cleanName.toLowerCase().includes('logistics'))) {
              
              this.results.push({
                company: cleanName,
                entity_type: type.trim() || 'LLC',
                filed_date: cleanDate,
                state: 'TX',
                source: 'sos_tx',
                insurance_type: 'commercial_auto',
                naics_code: '484',
                status: 'new',
                created_at: new Date()
              });
              
              console.log(`[SOS-TX] Found: ${cleanName}`);
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      console.log(`[SOS-TX] Total collected: ${this.results.length}`);
      
      // Submit to InsureFlowAI if we found anything
      if (this.results.length > 0) {
        await this.submitToInsureFlow();
      }
      
      return this.results;
      
    } catch (error) {
      console.error('[SOS-TX] Error:', error.message);
      // Take screenshot for debugging if needed
      // await page.screenshot({ path: 'error-screenshot.png' });
      throw error;
    } finally {
      await browser.close();
    }
  }

  async submitToInsureFlow() {
    for (const lead of this.results) {
      try {
        await axios.post(`${this.baseUrl}/api/leads`, lead, {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' }
        });
        console.log(`[SOS-TX] Saved to InsureFlow: ${lead.company}`);
      } catch (err) {
        console.error(`[SOS-TX] Failed to save ${lead.company}:`, err.message);
      }
    }
  }
}

module.exports = { TexasSOSScraper };
