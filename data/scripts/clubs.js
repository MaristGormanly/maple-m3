const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const cheerio = require('cheerio'); 
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
  try {
    await client.connect();
    console.log('Connected to database. Starting Club Directory scrape with Cheerio...');

    // 1. Fetch the HTML natively
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
    const html = await response.text();

    // 2. Parse with Cheerio
    const $ = cheerio.load(html);
    let extractedText = '';

    // Target headings and paragraphs in the main content area
    $('#main-content, .content-area, main').find('h2, h3, p, li').each((index, element) => {
      const text = $(element).text().replace(/\n\s*\n/g, '\n').trim();
      if (text) {
        extractedText += text + '\n';
      }
    });

    // Fallback if specific containers aren't found
    if (!extractedText.trim()) {
      console.log('Specific containers not found. Falling back to body parsing...');
      extractedText = $('body').text().replace(/\n\s*\n/g, '\n').trim();
    }

    // Clean non-ASCII characters to prevent vector noise
    extractedText = extractedText.replace(/[^\x00-\x7F]/g, " ");

    if (!extractedText) {
      console.error('Failed to extract text from Club Directory.');
      return;
    }

    console.log('Successfully extracted club data. Chunking for vectorization...');

    const chunks = chunkText(extractedText);
    console.log(`Created ${chunks.length} chunks. Generating OpenAI embeddings...`);

    // 3. Generate Embeddings and Insert
    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];

      const embeddingResponse = await openai.embeddings.create({
        model: embedModel, 
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

      console.log(`Inserted club chunk ${i + 1}/${chunks.length} into vector database.`);
    }

    console.log('Club Directory ingestion complete!');

  } catch (error) {
    console.error('Error during club scraping/ingestion:', error);
  } finally {
    await client.end();
  }
}

scrapeAndIngestClubs();