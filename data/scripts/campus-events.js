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

// Using the Daily Events URL which contains the most up-to-date schedule
const SOURCE_URL = 'https://www.marist.edu/daily-events';
const SOURCE_TITLE = 'Marist Campus Events';
const SOURCE_TYPE = 'Events';

async function scrapeAndIngestEvents() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Campus Events scrape with Playwright...');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Increased timeout to ensure full rendering of the events list
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Extraction logic targeting the current Marist daily-events structure
    const events = await page.evaluate(() => {
      // Look for the main container that holds the daily schedule text
      const content = document.querySelector('.region-content, #main-content') || document.body;
      const text = content.innerText;
      
      // Split by date patterns (e.g., "Thursday, April 2nd") to isolate individual events
      const eventBlocks = text.split(/(?=\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s[A-Z][a-z]+\s\d+(?:st|nd|rd|th)?)/);
      
      return eventBlocks.slice(1).map(block => {
        const lines = block.split('\n').filter(l => l.trim() !== '');
        return {
          title: lines[2] || lines[1], // Often the 3rd line after date and time
          timeStr: lines[0],
          location: lines[1],
          description: block.substring(0, 500).trim(), // Taking a snippet for context
          url: window.location.href
        };
      }).filter(e => e.title && e.title.length > 3);
    });

    if (events.length === 0) {
      console.log('No event data could be extracted. Attempting fallback text extraction...');
      // If structured extraction fails, ingest the whole page as a fallback chunk
      const pageText = await page.evaluate(() => document.body.innerText);
      events.push({
        title: "Daily Events Overview",
        timeStr: "Various",
        location: "Campus-wide",
        description: pageText.slice(0, 1000),
        url: SOURCE_URL
      });
    }

    console.log(`Extracted ${events.length} event records. Generating embeddings...`);

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const chunkContent = `Event: ${event.title}\nTime: ${event.timeStr}\nLocation: ${event.location}\nDescription: ${event.description}`;

      try {
        // 1. Relational Insert
        const eventInsertQuery = `
          INSERT INTO CampusEvents (title, description, location, start_time, category)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4);
        `;
        await client.query(eventInsertQuery, [event.title, event.description, event.location, SOURCE_TYPE]);

        // 2. Vector Ingestion
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
        const docResult = await client.query(docInsertQuery, [SOURCE_TITLE, event.url, SOURCE_TYPE, i, chunkContent]);
        const docId = docResult.rows[0].doc_id;

        const vectorInsertQuery = `
          INSERT INTO DocumentEmbeddings (doc_id, embedding)
          VALUES ($1, $2);
        `;
        await client.query(vectorInsertQuery, [docId, `[${embeddingVector.join(',')}]`]);

        console.log(`Inserted chunk ${i + 1}/${events.length} into vector database.`);
      } catch (err) {
        console.error(`Failed to ingest event: ${event.title}`, err.message);
      }
    }

    console.log('Campus Events data ingestion complete!');
  } catch (error) {
    console.error('Error during scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestEvents();