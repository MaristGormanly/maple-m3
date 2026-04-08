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

/**
 * Constants for Dining Ingestion
 * Source: dineoncampus.com/marist/hours-of-operation
 */
const SOURCE_URL = 'https://dineoncampus.com/marist/hours-of-operation';
const SOURCE_TITLE = 'Marist Dining Hours of Operation';
const SOURCE_TYPE = 'Dining';

/**
 * Chunking Strategy: Consistent with project specs for text-heavy sources.
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

async function scrapeAndIngestDining() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Dining Hours scrape with Playwright...');

    // 1. Launch Playwright
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Navigate and wait for network idle to ensure the dining cards load
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle' });

    // 2. Extraction Strategy
    // We target the main container for dining locations to avoid header/footer noise
    let extractedText = await page.evaluate(() => {
      // Dine On Campus usually uses specific classes for their location cards
      const diningContainer = document.querySelector('.container') || document.body;
      
      // Remove scripts and styles from extraction
      const scripts = diningContainer.querySelectorAll('script, style');
      scripts.forEach(s => s.remove());

      return diningContainer.innerText.replace(/\n\s*\n/g, '\n').trim();
    });

    if (!extractedText) {
      console.error('Failed to extract text from Dining page.');
      return;
    }

    // Clean non-ASCII characters to prevent vectorization issues (as seen in gym-pool.js)
    extractedText = extractedText.replace(/[^\x00-\x7F]/g, " ");

    console.log('Successfully extracted dining data. Chunking for vectorization...');

    // 3. Chunk the Data
    const chunks = chunkText(extractedText);
    console.log(`Created ${chunks.length} chunks. Generating embeddings...`);

    // 4. Generate Embeddings and Insert into Database
    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];

      // Generate embeddings using text-embedding-3-small as required by spec
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunkContent,
      });
      const embeddingVector = embeddingResponse.data[0].embedding;

      // Insert raw content and metadata into Documents table
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

      // Insert vector representation into DocumentEmbeddings table
      const vectorString = `[${embeddingVector.join(',')}]`;
      const vectorInsertQuery = `
        INSERT INTO DocumentEmbeddings (doc_id, embedding)
        VALUES ($1, $2);
      `;
      await client.query(vectorInsertQuery, [docId, vectorString]);

      console.log(`Inserted dining chunk ${i + 1}/${chunks.length} into vector database.`);
    }

    console.log('Dining hours ingestion complete!');

  } catch (error) {
    console.error('Error during dining scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestDining();