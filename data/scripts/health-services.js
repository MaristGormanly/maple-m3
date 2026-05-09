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

// Constants from Spec Document
const SOURCE_URL = 'https://www.marist.edu/student-life/services/health-services';
const SOURCE_TITLE = 'Health Services';
const SOURCE_TYPE = 'Health';

/**
 * Helper function to clean noise from scraped text.
 * Implements the "Parsing Strategy" to remove messy HTML/CSS.
 */
function cleanScrapedText(text) {
  return text
    .replace(/@media[^{]+\{[^}]+\}/g, '') // Remove CSS media queries
    .replace(/[^{]+\{[^}]+\}/g, '')      // Remove general CSS blocks
    .replace(/var\s+\$[^;]+;/g, '')      // Remove JS variable declarations
    .replace(/\$\([^)]+\)[^;]+;/g, '')   // Remove jQuery-style code
    .replace(/\s+/g, ' ')                // Collapse multiple spaces/newlines
    .trim();
}

/**
 * Helper function to chunk text.
 * Uses 500-token chunks (approx 400 words) with 10% overlap.
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

async function scrapeAndIngestHealthServices() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Health Services scrape...');

    // 1. Launch Playwright
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle' });

    // 2. Extract Text using targeted selectors to avoid global nav/footer noise
    let rawText = await page.evaluate(() => {
      // Marist CMS specific selectors
      const contentArea = document.getElementById('main-content') || 
                          document.querySelector('.portlet-layout') || 
                          document.querySelector('main');

      if (!contentArea) return "";

      // Clone node to manipulate without affecting the page
      const clone = contentArea.cloneNode(true);

      // Explicitly remove noise elements
      const noiseSelectors = [
        'script', 'style', 'nav', 'header', 'footer', 
        '.modal', '.dropdown', '#header-navigation-bar',
        '.portlet-topper'
      ];
      
      noiseSelectors.forEach(selector => {
        clone.querySelectorAll(selector).forEach(el => el.remove());
      });

      return clone.innerText.replace(/\n\s*\n/g, '\n').trim();
    });

    if (!rawText) {
      console.error('Extraction failed: No content found in targeted selectors.');
      return;
    }

    // Clean the extracted text to remove any remaining CSS/JS
    const cleanedText = cleanScrapedText(rawText);
    console.log('Successfully cleaned text. Chunking data...');

    // 3. Chunk the Data
    const chunks = chunkText(cleanedText);
    console.log(`Created ${chunks.length} chunks. Generating embeddings...`);

    // 4. Generate Embeddings and Insert into Database
    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];

      const embeddingResponse = await openai.embeddings.create({
        model: embedModel,
        input: chunkContent,
      });
      const embeddingVector = embeddingResponse.data[0].embedding;

      // Current system timestamp for freshness tracking
      const now = new Date().toISOString(); 

      // Insert into Documents Table with mandatory metadata
      const docInsertQuery = `
        INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING doc_id;
      `;
      const docResult = await client.query(docInsertQuery, [
        SOURCE_TITLE,
        SOURCE_URL,
        SOURCE_TYPE,
        i,
        chunkContent,
        now
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

    console.log('Health Services data ingestion complete!');

  } catch (error) {
    console.error('Error during scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestHealthServices();