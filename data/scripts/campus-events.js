const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const { chromium } = require('playwright');
const { OpenAI } = require('openai');

let openai;
let embedModel;

if (process.env.USE_LOCAL_MODEL === 'true') {
  openai = new OpenAI({
    baseURL: 'http://localhost:11434/v1', 
    apiKey: 'ollama', 
  });
  embedModel = 'nomic-embed-text'; 
} else {
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
    
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const events = await page.evaluate(() => {
      const content = document.querySelector('.region-content, #main-content') || document.body;
      const lines = content.innerText.split('\n').map(l => l.trim()).filter(l => l !== '');
      
      const extractedEvents = [];
      let currentBlock = [];
      
      const dateRegex = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+[A-Za-z]+\s+\d+(st|nd|rd|th)?\s*@.*$/i;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (dateRegex.test(line)) {
          const timeStr = line;
          const location = (i + 1 < lines.length) ? lines[i + 1] : 'Unknown';
          
          const cleanBlock = currentBlock.filter(l => 
            !l.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d+$/i) &&
            !l.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i) &&
            !['Upcoming Events', 'Single Day Events', 'Events Title', 'MARIST University EVENTS', 'Events Calendar'].includes(l)
          );

          let title = cleanBlock.length > 0 ? cleanBlock[0] : 'Unknown Title';
          
          if (cleanBlock.length > 1 && cleanBlock[1] === title) {
            cleanBlock.splice(1, 1);
          }
          
          const description = cleanBlock.slice(1).join('\n').substring(0, 500).trim();
          
          extractedEvents.push({
            title,
            timeStr,
            location,
            description,
            url: window.location.href
          });
          
          currentBlock = [];
          i++; 
        } else {
          currentBlock.push(line);
        }
      }
      
      return extractedEvents.filter(e => e.title && e.title !== 'Unknown Title');
    });

    // - Remove the first event from the array bc not real event ---
    if (events.length > 0) {
      console.log(`Dropping the first sticky event: "${events[0].title}"`);
      events.shift(); 
    }

    if (events.length === 0) {
      console.log('No event data could be extracted. Attempting fallback text extraction...');
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

        console.log(`Inserted chunk ${i + 1}/${events.length} into vector database. (${event.title})`);
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