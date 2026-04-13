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

async function scrapeAndIngestRec() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Rec Center scrape...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS });

    // Extract the raw text from the content area
    const facilityData = await page.evaluate(() => {
      const content = document.querySelector('.article-content')?.innerText || "";
      
      // Split logic based on known headers in the HTML provided
      const buildingHours = content.match(/Building Hours([\s\S]*?)Pool Hours/)?.[1]?.trim();
      const poolHours = content.match(/Pool Hours([\s\S]*?)Building hours may/)?.[1]?.trim();
      const mccormick = content.match(/McCormick Hall Fitness Center([\s\S]*?)Marketplace/)?.[1]?.trim();
      const marketplace = content.match(/Marketplace Fitness Center([\s\S]*?)Please call/)?.[1]?.trim();

      return [
        { title: "McCann Building Hours", text: buildingHours },
        { title: "McCann Pool Hours", text: poolHours },
        { title: "McCormick Hall Fitness Center", text: mccormick },
        { title: "Marketplace Fitness Center", text: marketplace }
      ].filter(s => s.text); // Remove empty sections
    });

    if (facilityData.length === 0) {
      console.log('No facility data could be extracted.');
      return;
    }

    console.log(`Found ${facilityData.length} sections. Generating embeddings...`);

    for (let i = 0; i < facilityData.length; i++) {
      const section = facilityData[i];
      
      try {
        // Clean non-ASCII and format the chunk
        const cleanText = section.text.replace(/[^\x00-\x7F]/g, " ").replace(/\s+/g, ' ').trim();
        const chunkContent = `${section.title}\n${cleanText}\nSource: ${SOURCE_URL}`;

        // 1. Generate actual embeddings
        const embeddingResponse = await openai.embeddings.create({
          model: embedModel, 
          input: chunkContent,
        });
        const embeddingVector = embeddingResponse.data[0].embedding;

        // 2. Insert into Documents Table (Matching your working example's schema)
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

        // 3. Insert into DocumentEmbeddings Table
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