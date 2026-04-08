const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const { chromium } = require('playwright'); // Swapping Cheerio out for Playwright
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
const SOURCE_URL = 'https://library.marist.edu/web/marist-library/hours-full';
const SOURCE_TITLE = 'Cannavino Library Hours & Services';
const SOURCE_TYPE = 'Library';

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

async function scrapeAndIngestLibrary() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting library scrape with Playwright...');

    // 1. Launch Playwright (Headless Browser)
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Go to the URL and wait until the network is mostly idle 
    // This gives the JavaScript calendar widgets time to load their data
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle' });

    // 2. Extract Text directly from the rendered page
    // We grab the visible text and clean up excessive blank lines
    let extractedText = await page.evaluate(() => {
      // Try to target the main content area, fallback to body if standard tags aren't used
      const mainContent = document.querySelector('main') || document.body;
      return mainContent.innerText.replace(/\n\s*\n/g, '\n').trim();
    });

    if (!extractedText) {
      console.log('No text could be extracted from the page.');
      return;
    }

    console.log('Successfully extracted dynamically rendered text. Chunking data...');

    // 3. Chunk the Data
    const chunks = chunkText(extractedText);
    console.log(`Created ${chunks.length} chunks. Generating embeddings...`);

    // 4. Generate Embeddings and Insert into Database
    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];

      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunkContent,
      });
      const embeddingVector = embeddingResponse.data[0].embedding;

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

      const vectorString = `[${embeddingVector.join(',')}]`;
      const vectorInsertQuery = `
        INSERT INTO DocumentEmbeddings (doc_id, embedding)
        VALUES ($1, $2);
      `;
      await client.query(vectorInsertQuery, [docId, vectorString]);

      console.log(`Inserted chunk ${i + 1}/${chunks.length} into vector database.`);
    }

    console.log('Library data ingestion complete!');

  } catch (error) {
    console.error('Error during scraping/ingestion:', error);
  } finally {
    // Ensure the browser closes even if the script crashes
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestLibrary();