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
 * Constants defined in the MAPLE_M3 Project Design Doc
 * Source: marist.edu/student-life/involvement
 */
const SOURCE_URL = 'https://www.marist.edu/student-life/involvement';
const SOURCE_TITLE = 'Marist Club Directory';
const SOURCE_TYPE = 'Clubs';

/**
 * Chunking Strategy: 500-token chunks with 10% overlap 
 * for text-heavy sources as per spec.
 */
function chunkText(text, maxWords = 450, overlapWords = 45) {
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

async function scrapeAndIngestClubs() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Club Directory scrape...');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Navigate to the club involvement page
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle' });

    // Extraction Strategy: Targeting lists of student organizations
    // per the Data Ingestion & Processing table in the spec.
    let extractedText = await page.evaluate(() => {
      // Targets main content or containers likely to hold club lists
      const clubContent = document.querySelector('.content-area') || 
                          document.querySelector('#main-content') || 
                          document.body;
      
      // Clean up whitespace and line breaks
      return clubContent.innerText.replace(/\n\s*\n/g, '\n').trim();
    });

    if (!extractedText) {
      console.error('Failed to extract text from Club Directory.');
      return;
    }

    console.log('Successfully extracted club data. Chunking for vectorization...');

    const chunks = chunkText(extractedText);
    console.log(`Created ${chunks.length} chunks. Generating embeddings...`);

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

      console.log(`Inserted club chunk ${i + 1}/${chunks.length} into vector database.`);
    }

    console.log('Club Directory ingestion complete!');

  } catch (error) {
    console.error('Error during club scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestClubs();