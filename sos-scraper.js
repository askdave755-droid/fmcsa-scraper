const { chromium } = require('playwright');
const axios = require('axios');

class OhioSOSScraper {
  constructor() {
    this.results = [];
    this.baseUrl = process.env.INSUREFLOW_API_URL || 'https://insureflow-ai-production.up.railway.app';
    this.fastappendKey = process.env.FASTAPPEND_API_KEY;
  }

  async scrape(daysBack = 7) {
    console.log(`[SOS-OH] Starting scrape for last ${daysBack} days...`);
    
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
      const page = await browser.newPage();
      
      // Ohio Business Search
      await page.goto('https://businesssearch.ohiosos.gov/', {
        waitUntil: 'networkidle',
        timeout: 60000
      });

      // Search for trucking companies
      await page.fill('input[name="SearchTerm"]', 'TRUCKING');
      await page.click('button[type="submit"], input[type="submit"]');
      
      await page.waitForSelector('table tbody tr', { timeout: 30000 });
      
      const rows = await page.$$('table tbody tr');
      console.log(`[SOS-OH] Found ${rows.length} rows`);
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);
      
      for (const row of rows.slice(0, 20)) {
        try {
          const cells = await row.$$('td');
          if (cells.length >= 3) {
            const name = await cells[0].textContent();
            const type = await cells[1].textContent();
            const dateText = await cells[2].textContent();
            
            const filedDate = new Date(dateText.trim());
            
            // Filter: Recent + Trucking related
            if (filedDate >= cutoffDate && 
                (name.toLowerCase().includes('truck') || 
                 name.toLowerCase().includes('transport') ||
                 name.toLowerCase().includes('logistics'))) {
              
              const lead = {
                id: `oh-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                company: name.trim(),
                entity_type: type.trim(),
                filed_date: dateText.trim(),
                state: 'OH',
                source: 'sos_oh',
                insurance_type: 'commercial_auto',
                status: 'skip_tracing'
              };
              
              this.results.push(lead);
              console.log(`[SOS-OH] Found: ${lead.company}`);
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      console.log(`[SOS-OH] Total: ${this.results.length} leads found`);
      
      // NOW SKIP TRACE AND CALL
      if (this.results.length > 0 && this.fastappendKey) {
        await this.skipTraceAndCallAll(this.results);
      } else if (this.results.length > 0) {
        // Save to DB without phone for now
        await this.saveToDatabase(this.results);
      }
      
      return this.results;
      
    } catch (error) {
      console.error('[SOS-OH] Error:', error.message);
      return [];
    } finally {
      await browser.close();
    }
  }

  // FASTAPPEND SKIP TRACE + VAPI CALL
  async skipTraceAndCallAll(leads) {
    console.log(`[FastAppend] Starting skip trace for ${leads.length} leads...`);
    
    for (const lead of leads) {
      try {
        console.log(`[FastAppend] Looking up: ${lead.company}...`);
        
        // 1. Call FastAppend
        const response = await axios.post(
          'https://api.fastappend.com/v1/api/business-trace/',
          {
            business_name: lead.company,
            state: lead.state,
            city: null
          },
          {
            headers: { 
              'Authorization': `Bearer ${this.fastappendKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          }
        );

        // 2. Check if we got phone numbers
        if (response.data?.phone_numbers?.length > 0) {
          const phone = response.data.phone_numbers[0]; // Best match
          
          console.log(`[FastAppend] ✅ Got phone for ${lead.company}: ${phone}`);
          
          // 3. Update lead with phone
          const updatedLead = {
            ...lead,
            phone: phone,
            phone_confidence: response.data.confidence_score || 0.7,
            skip_traced: true,
            status: 'calling'
          };
          
          // 4. Save to database first
          await this.saveToDatabase([updatedLead]);
          
          // 5. TRIGGER VAPI AI CALL IMMEDIATELY
          await this.triggerVapiCall(updatedLead);
          
        } else {
          console.log(`[FastAppend] ❌ No phone found for ${lead.company}`);
          // Save without phone for manual lookup later
          await this.saveToDatabase([lead]);
        }
        
        // Wait 1 second between calls (rate limit)
        await new Promise(r => setTimeout(r, 1000));
        
      } catch (error) {
        console.error(`[FastAppend] Error for ${lead.company}:`, error.message);
        // Save lead anyway, can retry later
        await this.saveToDatabase([lead]);
      }
    }
  }

  // TRIGGER VAPI AI CALL
  async triggerVapiCall(lead) {
    try {
      console.log(`[Vapi] Calling ${lead.company} at ${lead.phone}...`);
      
      const vapiResponse = await axios.post(
        'https://api.vapi.ai/call',
        {
          assistantId: process.env.VAPI_ASSISTANT_ID,
          phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
          customer: {
            number: phone,
            name: lead.company
          },
          assistantOverrides: {
            variables: {
              lead_name: "Owner",
              company: lead.company,
              state: lead.state,
              natural_opener: `Hey, it's Brady with Smart Choice. I saw ${lead.company} just filed with the Ohio Secretary of State. Congratulations on the new business. Are you handling the commercial auto insurance for the trucks?`
            }
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`[Vapi] ✅ Call initiated: ${vapiResponse.data.id}`);
      
      // Update lead with call ID
      await axios.post(`${this.baseUrl}/api/leads/update-call`, {
        lead_id: lead.id,
        vapi_call_id: vapiResponse.data.id,
        status: 'calling'
      });
      
    } catch (error) {
      console.error(`[Vapi] Failed to call ${lead.company}:`, error.message);
    }
  }

  // SAVE TO INSUREFLOW DATABASE
  async saveToDatabase(leads) {
    for (const lead of leads) {
      try {
        await axios.post(`${this.baseUrl}/api/leads`, lead, {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' }
        });
        console.log(`[DB] Saved: ${lead.company}`);
      } catch (err) {
        console.error(`[DB] Failed to save ${lead.company}:`, err.message);
      }
    }
  }
}

// CSV UPLOAD HANDLER (For manual uploads from other states)
async function processCSVUpload(csvData, state) {
  console.log(`[CSV] Processing ${csvData.length} rows for ${state}...`);
  const scraper = new OhioSOSScraper();
  
  // Transform CSV to lead format
  const leads = csvData.map((row, idx) => ({
    id: `csv-${state}-${Date.now()}-${idx}`,
    company: row.Company || row.BusinessName || row.Name,
    entity_type: row.Type || 'LLC',
    filed_date: row.Date || row.FiledDate,
    state: state,
    source: `csv_${state.toLowerCase()}`,
    insurance_type: 'commercial_auto',
    status: 'skip_tracing'
  })).filter(l => l.company); // Remove empty rows
  
  // Skip trace and call
  if (leads.length > 0 && process.env.FASTAPPEND_API_KEY) {
    await scraper.skipTraceAndCallAll(leads);
  }
  
  return leads;
}

module.exports = { OhioSOSScraper, processCSVUpload };
