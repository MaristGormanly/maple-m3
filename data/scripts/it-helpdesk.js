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

const SOURCE_URL = 'https://www.marist.edu/helpdesk';
const SOURCE_TITLE = 'IT Helpdesk Support & FAQs';
const SOURCE_TYPE = 'IT Support';

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

async function scrapeAndIngestITHelpdesk() {
  try {
    await client.connect();
    console.log('Connected to database. Starting IT Helpdesk scrape with Cheerio...');

    // 1. Fetch the HTML
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
    const html = await response.text();

    // 2. Parse with Cheerio
    const $ = cheerio.load(html);
    let extractedText = '';

    // ATTEMPT A: Look for standard <details> / <summary> accordion tags
    $('details').each((index, element) => {
      const question = $(element).find('summary').text().trim();
      // Get the rest of the text inside the details tag (the answer)
      const answer = $(element).text().replace(question, '').trim();
      if (question && answer) {
        extractedText += `Question: ${question}\nAnswer: ${answer}\n\n`;
      }
    });

    // ATTEMPT B: Look for Bootstrap-style accordions or elements with "accordion" class
    if (!extractedText.trim()) {
      $('[class*="accordion"]').each((index, element) => {
        const text = $(element).text().replace(/\n\s*\n/g, '\n').trim();
        if (text) {
          extractedText += text + '\n\n';
        }
      });
    }

    // FALLBACK: If no accordions are found, grab the main content area
    if (!extractedText.trim()) {
      console.log('No specific accordion elements found. Falling back to body parsing...');
      const mainContent = $('main').length ? $('main') : $('body');
      extractedText = mainContent.text().replace(/\n\s*\n/g, '\n').trim();
    }

    // Clean non-ASCII characters to prevent vector noise
    extractedText = extractedText.replace(/[^\x00-\x7F]/g, " ");

    console.log('Successfully extracted FAQ text. Chunking data...');

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

    console.log('IT Helpdesk data ingestion complete!');

  } catch (error) {
    console.error('Error during scraping/ingestion:', error);
  } finally {
    await client.end();
  }
}

scrapeAndIngestITHelpdesk();