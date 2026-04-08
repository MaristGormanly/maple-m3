const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const { chromium } = require('playwright');
const { OpenAI } = require('openai');

let openai;
let embedModel;

if (process.env.USE_LOCAL_MODEL === 'true') {
  // Point to the DGX Spark via your SSH tunnel
  openai = new OpenAI({
    baseURL: 'http://localhost:11434/v1', 
    apiKey: 'ollama', 
  });
  embedModel = 'nomic-embed-text'; 
} else {
  // Fallback to real OpenAI if needed later 
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  embedModel = 'text-embedding-3-small'; 
}

const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const SOURCE_URL = 'https://www.marist.edu/daily-events';
const SOURCE_TITLE = 'Marist Daily News & Events';
const SOURCE_TYPE = 'News';

async function scrapeAndIngestNews() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Marist News scrape with Playwright...');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Navigate and wait for the Vue.js app to finish loading the dynamic content
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.singleday-events', { timeout: 15000 });

    // 1. Extract the dynamically rendered content from the Vue template
    const articles = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.singleday-events .container'));
      return items.map(item => {
        const titleEl = item.querySelector('.title h3');
        const descEl = item.querySelector('.description');
        const timeEl = item.querySelector('.startTime');
        const locEl = item.querySelector('.location');

        return {
          title: titleEl ? titleEl.innerText.trim() : null,
          content: descEl ? descEl.innerText.trim() : '',
          metadata: `Time: ${timeEl ? timeEl.innerText.trim() : 'N/A'} | Location: ${locEl ? locEl.innerText.trim() : 'N/A'}`
        };
      }).filter(a => a.title);
    });

    if (articles.length === 0) {
      console.log('No news articles could be extracted from the rendered page.');
      return;
    }

    console.log(`Successfully extracted ${articles.length} news items. Generating embeddings...`);

    // 2. Process and Ingest
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const chunkContent = `Headline: ${article.title}\nDetails: ${article.metadata}\n\nSummary: ${article.content}`;

      try {
      
        const embeddingResponse = await openai.embeddings.create({
          model: embedModel, 
          input: chunkContent,
        });
        const embeddingVector = embeddingResponse.data[0].embedding;

        // Insert into Documents Table
        const docInsertQuery = `
          INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING doc_id;
        `;
        const docResult = await client.query(docInsertQuery, [
          SOURCE_TITLE,
          SOURCE_URL,
          SOURCE_TYPE,
          i,
          chunkContent
        ]);
        const docId = docResult.rows[0].doc_id;

        // Insert into DocumentEmbeddings Table
        const vectorInsertQuery = `
          INSERT INTO DocumentEmbeddings (doc_id, embedding)
          VALUES ($1, $2);
        `;
        await client.query(vectorInsertQuery, [docId, `[${embeddingVector.join(',')}]`]);

        console.log(`Inserted chunk ${i + 1}/${articles.length} into vector database.`);

      } catch (innerError) {
        console.error(`Failed to ingest news item: ${article.title}`, innerError.message);
      }
    }

    console.log('Marist News ingestion complete!');

  } catch (error) {
    console.error('Error during scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestNews();