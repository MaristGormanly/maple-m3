const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const { chromium } = require('playwright');
const { OpenAI } = require('openai');

/**
 * MAPLE M3 Configuration
 * Supports local DGX Spark (Ollama) or OpenAI frontier models
 */
const USE_LOCAL = process.env.USE_LOCAL_MODEL === 'true';
const openai = new OpenAI({
  baseURL: USE_LOCAL ? 'http://localhost:11434/v1' : undefined,
  apiKey: USE_LOCAL ? 'ollama' : process.env.OPENAI_API_KEY,
});

const embedModel = USE_LOCAL ? 'nomic-embed-text' : 'text-embedding-3-small';

const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const TARGET_PAGES = [
  {
    url: 'https://www.marist.edu/clienttech/new-student-information',
    title: 'Client Tech - New Student Information',
    category: 'New Student IT Info'
  },
  {
    url: 'https://www.marist.edu/clienttech/connect-to-the-network',
    title: 'Client Tech - Connect to the Network',
    category: 'Network Connection Guide'
  }
];

const SOURCE_TYPE = 'IT Support';

async function scrapeClientTech() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Client Tech ingestion...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    for (const target of TARGET_PAGES) {
      console.log(`\nNavigating to: ${target.url}`);
      await page.goto(target.url, { waitUntil: 'networkidle', timeout: 60000 });

      const extractedChunks = await page.evaluate((category) => {
        const results = [];
        const seenTitles = new Set();

        // Strategy 1: Extract from Accordions/Collapsibles (specifically for devices)
        // Targets common Marist classes like .collapse-card, .accordion, .panel
        const accordions = document.querySelectorAll('.collapse-card, .accordion-item, .panel, details');
        
        if (accordions.length > 0) {
          accordions.forEach(acc => {
            const titleEl = acc.querySelector('.collapse-header-text, .accordion-button, .panel-heading, summary');
            const bodyEl = acc.querySelector('.collapse, .accordion-collapse, .panel-body') || acc;
            
            if (titleEl && bodyEl) {
              const title = titleEl.innerText.trim();
              // Clean up the text to remove non-essential whitespace/newlines
              const body = bodyEl.innerText.trim().replace(/\s+/g, ' ');
              
              if (title && body && !seenTitles.has(title)) {
                results.push({ category: category, question: title, answer_text: body });
                seenTitles.add(title);
              }
            }
          });
        }

        // Strategy 2: Fallback to Header-Based Sections (for New Student Info general text)
        // If the page relies on H2/H3s instead of accordions, we parse text until the next header
        if (results.length === 0) {
          const headers = Array.from(document.querySelectorAll('h2, h3'));
          headers.forEach(header => {
            const title = header.innerText.trim();
            if (!title || seenTitles.has(title)) return;

            let body = '';
            let nextEl = header.nextElementSibling;
            
            // Gather all text elements until we hit the next header of the same or higher level
            while (nextEl && !['H1', 'H2', 'H3'].includes(nextEl.tagName)) {
              body += ' ' + nextEl.innerText;
              nextEl = nextEl.nextElementSibling;
            }

            body = body.replace(/\s+/g, ' ').trim();
            
            if (body.length > 20) { // Ignore empty or extremely short sections
              results.push({ category: category, question: title, answer_text: body });
              seenTitles.add(title);
            }
          });
        }

        return results;
      }, target.category);

      console.log(`Found ${extractedChunks.length} informative chunks on ${target.title}. Processing vectors...`);

      for (let i = 0; i < extractedChunks.length; i++) {
        const item = extractedChunks[i];
        
        // M3 Design Doc: One-record-per-chunk strategy using required JSON fields
        // Limit string size to prevent exceeding token context limits
        const chunkContent = JSON.stringify({
          category: item.category,
          question: item.question,
          answer_text: item.answer_text.substring(0, 2500)
        });

        try {
          // Generate embeddings via configured model
          const embeddingRes = await openai.embeddings.create({
            model: embedModel,
            input: chunkContent,
          });

          const vector = `[${embeddingRes.data[0].embedding.join(',')}]`;

          // Insert Document record with mandatory metadata for source attribution
          const docRes = await client.query(
            `INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content, last_updated)
             VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING doc_id`,
            [`${target.title}: ${item.question}`, target.url, SOURCE_TYPE, i, chunkContent]
          );

          const docId = docRes.rows[0].doc_id;

          // Insert Vector into DocumentEmbeddings for pgvector search
          await client.query(
            `INSERT INTO DocumentEmbeddings (doc_id, embedding) VALUES ($1, $2)`,
            [docId, vector]
          );

          console.log(`   [+] Ingested: ${item.question}`);
        } catch (dbErr) {
          console.error(`   [!] DB/Embedding Error on "${item.question}":`, dbErr.message);
        }
      }
    }
    console.log('\nClient Tech ingestion complete!');
  } catch (err) {
    console.error('Fatal Scraper Error:', err.message);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeClientTech();