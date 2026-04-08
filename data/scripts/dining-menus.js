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

// Initialize PostgreSQL Client
const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

/**
 * Constants for Menu Ingestion
 */
const SOURCE_URL = 'https://dineoncampus.com/marist/whats-on-the-menu';
const SOURCE_TITLE = 'Marist Daily Dining Menu';
const SOURCE_TYPE = 'Menu';

/**
 * Chunking Strategy: 400-token chunks with 10% overlap 
 * aligned with text-heavy source processing.
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

async function scrapeAndIngestMenu() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Menu scrape with Playwright...');

    // 1. Launch Playwright
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Set a longer timeout as menu data can be slow to fetch from the API
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // 2. Extraction Strategy
    // The menu page uses complex components; we target the main menu wrapper
    let extractedText = await page.evaluate(() => {
      // Targets the specific menu content area to avoid sidebar noise
      const menuContent = document.querySelector('.main-content') || 
                          document.querySelector('#menu-container') || 
                          document.body;
      
      // Remove interactive elements like buttons and dropdowns to keep text clean
      const uiElements = menuContent.querySelectorAll('button, select, nav');
      uiElements.forEach(el => el.remove());

      return menuContent.innerText.replace(/\n\s*\n/g, '\n').trim();
    });

    if (!extractedText) {
      console.error('Failed to extract text from the Menu page.');
      return;
    }

    // Requirement: Clean non-ASCII characters to prevent vectorization artifacts
    extractedText = extractedText.replace(/[^\x00-\x7F]/g, " ");

    console.log('Successfully extracted menu data. Chunking for vectorization...');

    // 3. Chunk the Data
    const chunks = chunkText(extractedText);
    console.log(`Created ${chunks.length} chunks. Generating embeddings...`);

    // 4. Generate Embeddings and Insert into Database
    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];

      // Use text-embedding-3-small as required by project spec
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

      // Insert Vector into DocumentEmbeddings
      const vectorString = `[${embeddingVector.join(',')}]`;
      const vectorInsertQuery = `
        INSERT INTO DocumentEmbeddings (doc_id, embedding)
        VALUES ($1, $2);
      `;
      await client.query(vectorInsertQuery, [docId, vectorString]);

      console.log(`Inserted menu chunk ${i + 1}/${chunks.length} into vector database.`);
    }

    console.log('Daily Menu ingestion complete!');

  } catch (error) {
    console.error('Error during menu scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestMenu();