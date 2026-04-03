const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const { chromium } = require('playwright');
const { OpenAI } = require('openai');

// Initialize OpenAI Client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize PostgreSQL Client
const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Constants from Spec Document
const SOURCE_URL = 'https://www.imleagues.com/spa/intramural/d18b10c460134db3af098b83375dac71/home';
const SOURCE_TITLE = 'Marist Intramural Sports Schedule & Registration';
const SOURCE_TYPE = 'Recreation';

/**
 * Helper function to chunk text.
 * The spec calls for 500-token chunks with 10% overlap. 
 * We approximate tokens to words (1 token ≈ 0.75 words).
 */
function chunkText(text, maxWords = 400, overlapWords = 40) {
  const words = text.split(/\s+/);
  const chunks = [];
  let i = 0;
  
  while (i < words.length) {
    const chunk = words.slice(i, i + maxWords).join(' ');
    chunks.push(chunk);
    i += maxWords - overlapWords;
  }
  return chunks;
}

async function scrapeAndIngestIntramurals() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Intramural scrape with Playwright...');

    // 1. Launch Playwright (Headless Browser)
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Navigate and wait for network to idle. 
    // IMLeagues is notoriously heavy and takes time to load the React/Angular dashboard components.
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // 2. Extract Text directly from the rendered page
    let extractedText = await page.evaluate(() => {
      // Target the main application container, fallback to body
      const mainContent = document.querySelector('.imleagues-container') || document.querySelector('#app') || document.body;
      return mainContent.innerText.replace(/\n\s*\n/g, '\n').trim();
    });

    if (!extractedText) {
      console.log('No text could be extracted from the IMLeagues page.');
      return;
    }

    // Clean any unusual characters that might come from the dashboard UI
    extractedText = extractedText.replace(/[^\x00-\x7F]/g, " ");

    console.log('Successfully extracted rendered dashboard text. Chunking data...');

    // 3. Chunk the Data
    const chunks = chunkText(extractedText);
    console.log(`Created ${chunks.length} chunks. Generating OpenAI embeddings...`);

    // 4. Generate Embeddings and Insert into Database
    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];

      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small', //
        input: chunkContent,
      });
      const embeddingVector = embeddingResponse.data[0].embedding;

      // Insert into Documents Table with mandatory metadata fields
      const docInsertQuery = `
        INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING doc_id;
      `;
      const docResult = await client.query(docInsertQuery, [
        SOURCE_TITLE,
        SOURCE_URL,
        SOURCE_TYPE,
        i, // chunk_index
        chunkContent
      ]);
      const docId = docResult.rows[0].doc_id;

      // Insert into DocumentEmbeddings Table
      const vectorString = `[${embeddingVector.join(',')}]`;
      const vectorInsertQuery = `
        INSERT INTO DocumentEmbeddings (doc_id, embedding)
        VALUES ($1, $2);
      `;
      await client.query(vectorInsertQuery, [docId, vectorString]);

      console.log(`Inserted chunk ${i + 1}/${chunks.length} into vector database.`);
    }

    console.log('Intramurals data ingestion complete!');

  } catch (error) {
    console.error('Error during scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestIntramurals();