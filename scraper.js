const { chromium } = require('playwright');
const axios = require('axios');
require('dotenv').config();

const INSUREFLOW_API = process.env.INSUREFLOW_API_URL || 'https://insureflow-ai-production.up.railway.app';
const API_KEY = process.env.INSUREFLOW_API_KEY;
const TARGET_STATES = (process.env.TARGET_STATES || 'MI,TX,OH,AL,AZ').split(',');

// FMCSA Search Configuration
const FMCSA_CONFIG = {
  baseUrl: 'https://safer.fmcsa.dot.gov/CompanySnapshot.aspx',
  searchUrl: 'https://safer.fmcsa.dot.gov/CompanySnapshot.aspx',
  rateLimit: 2000, // 2 seconds between requests
  maxPerState: 50 // Limit per run to avoid blocking
};

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeState(browser, state) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  
  const page = await context.newPage();
  const carriers = [];
  
  try {
    console.log(`[${state}] Starting scrape...`);
    
    // Navigate to FMCSA Company Snapshot
    await page.goto(FMCSA_CONFIG.baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
    
    // FMCSA uses a form-based search. The state search is via dropdown/select
    // Alternative: Use the query parameter approach if available
    // Try searching by state via URL parameter or form submission
    
    // Method: Search with state parameter
    const searchUrl = `${FMCSA_CONFIG.baseUrl}?SEARCHTYPE=carrier&STATE=${state}&BUSINESS_TYPE=carrier`;
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
    
    // Check if we got results or need to use the form
    const hasResults = await page.locator('text=Company Snapshot').count() > 0;
    
    if (!hasResults) {
      // Try form-based search
      await page.selectOption('select[name="STATE"]', state);
      await page.click('input[type="submit"], button[type="submit"]');
      await page.waitForLoadState('networkidle');
    }
    
    // Extract carrier links from results
    const carrierLinks = await page.$$eval('a[href*="USDOT"], a[href*="MC"]', links => 
      links.map(link => ({
        url: link.href,
        text: link.textContent.trim(),
        dot: link.href.match(/USDOT=(\d+)/)?.[1] || null
      }))
    );
    
    console.log(`[${state}] Found ${carrierLinks.length} carriers`);
    
    // Deep dive each carrier (limited to maxPerState)
    for (let i = 0; i < Math.min(carrierLinks.length, FMCSA_CONFIG.maxPerState); i++) {
      const carrier = carrierLinks[i];
      try {
        await delay(FMCSA_CONFIG.rateLimit);
        
        await page.goto(carrier.url, { waitUntil: 'networkidle', timeout: 20000 });
        
        // Extract carrier details
        const details = await page.evaluate(() => {
          const getText = (label) => {
            const el = Array.from(document.querySelectorAll('td, th, div'))
              .find(e => e.textContent.includes(label));
            return el ? el.nextElementSibling?.textContent?.trim() || '' : '';
          };
          
          const rawText = document.body.innerText;
          
          return {
            legalName: getText('Legal Name:') || getText('Carrier Name:') || '',
            dbaName: getText('DBA Name:') || '',
            usdot: getText('USDOT Number:') || rawText.match(/USDOT Number:\s*(\d+)/)?.[1] || '',
            mcNumber: getText('MC/MX Number:') || rawText.match(/MC-(\d+)/)?.[1] || '',
            phone: getText('Telephone:') || rawText.match(/(\d{3}-\d{3}-\d{4})/)?.[1] || '',
            fax: getText('Fax:') || '',
            email: getText('Email:') || rawText.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/)?.[1] || '',
            address: getText('Physical Address:') || getText('Address:') || '',
            city: getText('City:') || '',
            state: getText('State:') || '',
            zip: getText('ZIP Code:') || '',
            powerUnits: getText('Power Units:') || rawText.match(/Power Units:\s*(\d+)/)?.[1] || '0',
            drivers: getText('Drivers:') || rawText.match(/Drivers:\s*(\d+)/)?.[1] || '0',
            authorityStatus: getText('Operating Status:') || rawText.match(/Operating Status:\s*(\w+)/)?.[1] || '',
            carrierType: getText('Carrier Operation:') || ''
          };
        });
        
        if (details.usdot && details.phone) {
          carriers.push({
            ...details,
            source: 'fmcsa_scraper',
            scrapedAt: new Date().toISOString()
          });
          console.log(`[${state}] ✓ Extracted: ${details.legalName} (${details.powerUnits} units)`);
        }
        
      } catch (err) {
        console.error(`[${state}] Error scraping carrier ${carrier.dot}:`, err.message);
      }
    }
    
  } catch (error) {
    console.error(`[${state}] Scrape failed:`, error.message);
  } finally {
    await context.close();
  }
  
  return carriers;
}

async function pushToInsureFlow(carrier) {
  try {
    // Format phone to E.164
    const cleanPhone = carrier.phone.replace(/\D/g, '');
    const formattedPhone = cleanPhone.length === 10 ? `+1${cleanPhone}` : `+${cleanPhone}`;
    
    // Parse fleet size
    const vehicleCount = parseInt(carrier.powerUnits) || 0;
    const driverCount = parseInt(carrier.drivers) || 0;
    
    // Only push if has fleet and active authority
    if (vehicleCount < 1 || !carrier.authorityStatus?.toLowerCase().includes('active')) {
      console.log(`Skipping ${carrier.legalName}: inactive or no units`);
      return null;
    }
    
    const lead = {
      name: carrier.legalName || carrier.dbaName || 'Fleet Owner',
      company: carrier.legalName || carrier.dbaName,
      phone: formattedPhone,
      email: carrier.email || null,
      state: carrier.state || 'TX',
      dot_number: carrier.usdot,
      mc_number: carrier.mcNumber ? `MC-${carrier.mcNumber}` : null,
      vehicle_count: vehicleCount,
      driver_count: driverCount,
      authority_status: carrier.authorityStatus,
      insurance_type: 'commercial_auto',
      source: 'fmcsa_scraper',
      status: 'new',
      metadata: {
        address: carrier.address,
        city: carrier.city,
        carrier_type: carrier.carrierType
      }
    };
    
    const response = await axios.post(`${INSUREFLOW_API}/api/leads`, lead, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': API_KEY ? `Bearer ${API_KEY}` : undefined
      },
      timeout: 10000
    });
    
    console.log(`✓ Pushed to InsureFlow: ${carrier.legalName} (${response.data.id})`);
    return response.data;
    
  } catch (error) {
    console.error(`✗ Failed to push ${carrier.legalName}:`, error.response?.data || error.message);
    return null;
  }
}

async function main() {
  console.log('🚀 FMCSA Scraper Starting...');
  console.log(`Target States: ${TARGET_STATES.join(', ')}`);
  console.log(`API Endpoint: ${INSUREFLOW_API}`);
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const allCarriers = [];
  
  try {
    for (const state of TARGET_STATES) {
      const carriers = await scrapeState(browser, state.trim());
      allCarriers.push(...carriers);
      
      // Push to InsureFlow immediately to avoid memory buildup
      for (const carrier of carriers) {
        await pushToInsureFlow(carrier);
        await delay(500); // Rate limit API calls
      }
    }
    
    console.log(`\n✅ Complete! Processed ${allCarriers.length} carriers`);
    
  } catch (error) {
    console.error('Fatal error:', error);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { scrapeState, pushToInsureFlow };
