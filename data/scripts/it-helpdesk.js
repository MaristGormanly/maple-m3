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

const FAQ_URLS = [
  'https://teamdynamix.marist.edu/TDClient/92/Portal/KB/ArticleDet?ID=954',
  'https://teamdynamix.marist.edu/TDClient/92/Portal/KB/ArticleDet?ID=819',
  'https://teamdynamix.marist.edu/TDClient/92/Portal/KB/ArticleDet?ID=12389'
];

async function scrapeFAQs() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting IT FAQ ingestion...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    for (const url of FAQ_URLS) {
      console.log(`Scraping: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle' });

      const faqs = await page.evaluate(() => {
        const results = [];
        const panels = document.querySelectorAll('.panel');
        
        // Design Doc: Filtering out "stale" or non-informative records
        const noiseKeywords = ['attachments', 'related services', 'related offerings'];

        panels.forEach(panel => {
          const questionEl = panel.querySelector('.panel-heading');
          const answerEl = panel.querySelector('[aria-expanded], .panel-body');
          
          if (questionEl && answerEl) {
            const questionText = questionEl.innerText.trim();
            const answerText = answerEl.innerText.trim();
            const lowerHeader = questionText.toLowerCase();

            // Skip sections that don't provide student-facing value
            const isNoise = noiseKeywords.some(kw => lowerHeader.includes(kw)) || 
                            answerText.toLowerCase().includes('no attachments found');

            if (!isNoise && questionText.length > 0) {
              results.push({
                question: questionText,
                answer: answerText
              });
            }
          }
        });
        return results;
      });

      for (let i = 0; i < faqs.length; i++) {
        const item = faqs[i];
        
        // Design Doc: One-record-per-chunk strategy using required JSON fields
        const chunkContent = JSON.stringify({
          category: "IT FAQ",
          question: item.question,
          answer_text: item.answer.replace(/\s+/g, ' ').substring(0, 1500)
        });

        // Generate embeddings via configured model
        const embeddingRes = await openai.embeddings.create({
          model: embedModel,
          input: chunkContent,
        });

        // Insert Document record with mandatory metadata for source attribution
        const docRes = await client.query(
          `INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content, last_updated)
           VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING doc_id`,
          [`FAQ: ${item.question}`, url, 'IT Support', i, chunkContent]
        );

        const docId = docRes.rows[0].doc_id;

        // Insert Vector into DocumentEmbeddings for pgvector search
        await client.query(
          `INSERT INTO DocumentEmbeddings (doc_id, embedding) VALUES ($1, $2)`,
          [docId, `[${embeddingRes.data[0].embedding.join(',')}]`]
        );

        console.log(`Successfully ingested: ${item.question}`);
      }
    }
    console.log('IT Helpdesk ingestion complete!');
  } catch (err) {
    console.error('Ingestion Error:', err.message);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeFAQs();