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

const SOURCE_URL = 'https://goredfoxes.com/sports/2011/10/3/205308200.aspx';
const SOURCE_TITLE = 'Marist Athletics Facility Hours';
const SOURCE_TYPE = 'RecCenter';
const GOTO_TIMEOUT_MS = 60_000;

/** Natural-language hooks so embeddings match queries like "when is the pool open". */
const ENRICHMENT_BY_TITLE = {
  'McCann Center (Building & Pool Hours)': {
    facility: 'McCann Center',
    category: 'Recreation, McCann building, pool, gym, fitness, aquatics',
    aliases:
      'McCann pool, McCann gym, McCann Center pool, McCann building hours, athletics facility, rec center, recreation center, Red Foxes athletics',
    intent:
      'pool hours, gym hours, building hours, when is the pool open, when does the pool close, is the pool open, what time does the gym open, pool schedule, gym schedule, McCann hours',
  },
  'McCormick Hall Fitness Center': {
    facility: 'McCormick Hall Fitness Center',
    category: 'North End, McCormick Hall, fitness center, gym',
    aliases: 'McCormick gym, North End fitness, McCormick fitness',
    intent:
      'when is McCormick gym open, McCormick fitness hours, gym hours North End, fitness center schedule',
  },
  'Marketplace Fitness Center': {
    facility: 'Marketplace Fitness Center',
    category: 'Upper West Cedar, Marketplace, fitness center, gym',
    aliases: 'Marketplace gym, UWC fitness, Marketplace Cedar fitness',
    intent:
      'when is Marketplace gym open, Marketplace fitness hours, gym hours Upper West Cedar',
  },
};

const DEFAULT_ENRICHMENT = {
  facility: 'Marist athletics facility',
  category: 'Recreation, fitness, gym',
  aliases: 'rec center, athletics',
  intent: 'hours, when open, schedule, gym hours, pool hours',
};

/**
 * Wraps scraped text with structured labels + synonym/intent lines for better vector recall.
 */
function buildEnrichedChunkContent(sectionTitle, cleanScrapedText) {
  const meta = ENRICHMENT_BY_TITLE[sectionTitle] || DEFAULT_ENRICHMENT;
  return [
    `Facility: ${meta.facility}`,
    `Section: ${sectionTitle}`,
    `Category: ${meta.category}`,
    `Also known as: ${meta.aliases}`,
    `Common questions: ${meta.intent}`,
    '',
    'Official hours (from Marist Athletics):',
    cleanScrapedText,
    '',
    `Source: ${SOURCE_URL}`,
  ].join('\n');
}

async function scrapeAndIngestRec() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Rec Center scrape...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS });

    const facilityData = await page.evaluate(() => {
      const content = document.querySelector('.article-content')?.innerText || "";
      
      // Use a more flexible regex to capture sections based on the HTML provided
      // Grouping McCann Building and Pool together as requested
      const mccannMatch = content.match(/McCann\s+Center Hours([\s\S]*?)McCormick Hall/i);
      const mccormickMatch = content.match(/McCormick Hall Fitness Center([\s\S]*?)Marketplace/i);
      const marketplaceMatch = content.match(/Marketplace\s+Fitness Center([\s\S]*?)Please call/i);

      return [
        { 
          title: "McCann Center (Building/Gym & Pool Hours)", 
          text: mccannMatch ? mccannMatch[0].replace(/McCormick Hall/, "").trim() : null 
        },
        { 
          title: "McCormick Hall Fitness Center", 
          text: mccormickMatch ? mccormickMatch[0].replace(/Marketplace/, "").trim() : null 
        },
        { 
          title: "Marketplace Fitness Center", 
          text: marketplaceMatch ? marketplaceMatch[0].replace(/Please call/, "").trim() : null 
        }
      ].filter(s => s.text);
    });

    if (facilityData.length === 0) {
      console.log('No facility data could be extracted.');
      return;
    }

    console.log(`Found ${facilityData.length} combined sections. Generating embeddings...`);

    for (let i = 0; i < facilityData.length; i++) {
      const section = facilityData[i];
      
      try {
        // Clean up text: remove multiple spaces, fix non-breaking space artifacts
        const cleanText = section.text
          .replace(/\s+/g, ' ')
          .replace(/[^\x00-\x7F]/g, " ")
          .trim();

        const chunkContent = buildEnrichedChunkContent(section.title, cleanText);

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

        console.log(`Inserted chunk ${i + 1}/${facilityData.length}: ${section.title}`);

      } catch (innerError) {
        console.error(`Error processing section ${section.title}:`, innerError.message);
      }
    }

    console.log('Rec Center ingestion complete!');

  } catch (error) {
    console.error('Error during scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestRec();