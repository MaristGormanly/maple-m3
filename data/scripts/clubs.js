const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const { chromium } = require('playwright');
const { OpenAI } = require('openai');

let openai;
let embedModel;

if (process.env.USE_LOCAL_MODEL === 'true') {
  openai = new OpenAI({ baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' });
  embedModel = 'nomic-embed-text'; 
} else {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  embedModel = 'text-embedding-3-small'; 
}

const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const SOURCE_URL = 'https://www.marist.edu/clubs';
const SOURCE_TITLE = 'Marist Student Organizations Directory';
const SOURCE_TYPE = 'Clubs';

async function scrapeAndIngestClubs() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Finding clubs by category headers...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const listPage = await context.newPage();

    await listPage.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const clubData = await listPage.evaluate(() => {
      const results = [];
      const allHeaders = Array.from(document.querySelectorAll('h2'));
      const mainHeader = allHeaders.find(h => h.innerText.includes('Clubs and Organizations:'));
      
      if (!mainHeader) return [];

      const container = mainHeader.closest('section') || mainHeader.parentElement;
      const categories = Array.from(container.querySelectorAll('h3'));

      categories.forEach(catHeader => {
        const categoryName = catHeader.innerText.trim();
        const list = catHeader.nextElementSibling;
        
        if (list && list.tagName === 'UL') {
          const clubItems = Array.from(list.querySelectorAll('li'));
          clubItems.forEach(li => {
            const link = li.querySelector('a');
            results.push({
              name: li.innerText.trim(),
              category: categoryName,
              url: link ? link.href : null
            });
          });
        }
      });
      return results;
    });

    if (clubData.length === 0) {
      console.log('Zero clubs found. Check if the "Clubs and Organizations:" header exists.');
      return;
    }

    console.log(`Successfully identified ${clubData.length} clubs. Starting precision crawl...`);

    for (let i = 0; i < clubData.length; i++) {
      const club = clubData[i];
      let clubText = "Status: This club exists but has no additional info page.";

      if (club.url && !club.url.includes('mailto:')) {
        const detailPage = await context.newPage();
        try {
          console.log(`[Deep Crawl] Visiting: ${club.name}...`);
          await detailPage.goto(club.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          clubText = await detailPage.evaluate(() => {
            // 1. Remove navigation and footer to prevent "Mega Menu" scraping
            const bloat = [
                '#mobile-header-navigation', 
                '#header-navigation-bar', 
                'footer', 
                'header',
                '.navbar',
                '#scrape-alert',
                '.sr-only'
            ];
            bloat.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => el.remove());
            });

            // 2. Target the specific content areas (In Ultimate Frisbee, it's .basic-text)
            // We look for sections that aren't navigation
            const contentFragments = Array.from(document.querySelectorAll('section.basic-text, .journal-content-article, #main-content'));
            
            if (contentFragments.length > 0) {
                // Combine the text of all relevant sections
                return contentFragments.map(f => f.innerText).join('\n').trim();
            }
            
            return document.body.innerText.trim();
          });

          // Limit length to avoid massive token overhead from stray HTML
          clubText = clubText.substring(0, 3000);

        } catch (e) {
          clubText = "Status: Link exists but content could not be reached.";
        } finally {
          await detailPage.close();
        }
      }

      const finalContent = `Club Name: ${club.name}\nCategory: ${club.category}\nInfo: ${clubText}\nSource: ${club.url || SOURCE_URL}`;
      
      // COLLAPSE WHITESPACE: Converts massive indentation/newlines into a clean string
      const cleanContent = finalContent.replace(/[^\x00-\x7F]/g, " ").replace(/\s+/g, ' ').trim();

      try {
        const embeddingResponse = await openai.embeddings.create({
          model: embedModel, 
          input: cleanContent,
        });
        const embeddingVector = embeddingResponse.data[0].embedding;

        // 4. Insert into Documents Table
        const docInsertQuery = `
          INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING doc_id;
        `;
        const docResult = await client.query(docInsertQuery, [
          SOURCE_TITLE,
          club.url || SOURCE_URL,
          SOURCE_TYPE,
          i,
          cleanContent
        ]);
        const docId = docResult.rows[0].doc_id;

        // 5. Insert into DocumentEmbeddings Table
        const vectorString = `[${embeddingVector.join(',')}]`;
        const vectorInsertQuery = `
          INSERT INTO DocumentEmbeddings (doc_id, embedding)
          VALUES ($1, $2);
        `;
        await client.query(vectorInsertQuery, [docId, vectorString]);

        console.log(`Successfully ingested: ${club.name}`);

      } catch (dbErr) {
        console.error(`DB Error on ${club.name}:`, dbErr.message);
      }
    }

    console.log('Club Directory ingestion complete!');

  } catch (error) {
    console.error('Fatal Error:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestClubs();