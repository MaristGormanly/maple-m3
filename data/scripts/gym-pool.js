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
const SOURCE_URL = 'https://goredfoxes.com/sports/2011/10/3/205308200.aspx';
const SOURCE_TITLE = 'McCann Center Gym & Pool Hours';
const SOURCE_TYPE = 'Recreation';

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

async function scrapeAndIngestGym() {
  try {
    await client.connect();
    console.log('Connected to database. Starting Gym & Pool scrape with Cheerio...');

    // 1. Fetch the HTML
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
    const html = await response.text();

    // 2. Parse with Cheerio
    const $ = cheerio.load(html);
    let extractedText = '';

    // Target the main content areas where tables and paragraphs hold the hours
    $('article, .story-content, table').each((index, element) => {
      // Extract text and add a newline after block elements to preserve readability
      const text = $(element).text().replace(/\n\s*\n/g, '\n').trim();
      if (text) {
        extractedText += text + '\n';
      }
    });

    if (!extractedText.trim()) {
      console.log('No specific schedule elements found. Falling back to body parsing...');
      extractedText = $('body').text().replace(/\n\s*\n/g, '\n').trim();
    }

    // --- REQUIREMENT: Clean non-ASCII characters ---
    // This regex replaces zero-width spaces, smart quotes, and invisible formatting artifacts with standard spaces
    extractedText = extractedText.replace(/[^\x00-\x7F]/g, " ");

    console.log('Successfully extracted and cleaned schedule text. Chunking data...');

    // 3. Chunk the Data
    const chunks = chunkText(extractedText);
    console.log(`Created ${chunks.length} chunks. Generating OpenAI embeddings...`);

    // 4. Generate Embeddings and Insert into Database
    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];

      const embeddingResponse = await openai.embeddings.create({
        model: embedModel, 
        input: chunkContent,
      });
      const embeddingVector = embeddingResponse.data[0].embedding;

      // Insert into Documents Table with required metadata
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

    console.log('Gym & Pool data ingestion complete!');

  } catch (error) {
    console.error('Error during scraping/ingestion:', error);
  } finally {
    await client.end();
  }
}

scrapeAndIngestGym();