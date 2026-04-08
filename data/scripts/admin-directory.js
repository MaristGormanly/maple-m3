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

// Constants from Spec Document
const SOURCE_URL = 'https://www.marist.edu/directory';
const SOURCE_TITLE = 'Marist Administrative Directory';
const SOURCE_TYPE = 'Admin';

async function scrapeAndIngestAdmin() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Admin Directory scrape with Playwright...');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Navigate to the main directory
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle' });

    // 1. Extract all department links and basic info from the table
    const departments = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr')).slice(1);
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        const linkElement = cells[0]?.querySelector('a');
        return {
          department: cells[0]?.innerText.trim(),
          url: linkElement ? linkElement.href : null,
          phone: cells[1]?.innerText.trim(),
          location: cells[2]?.innerText.trim(),
        };
      }).filter(d => d.url);
    });

    if (departments.length === 0) {
      console.log('No directory data could be extracted from the page.');
      return;
    }

    console.log(`Found ${departments.length} departments. Generating embeddings and performing deep crawl...`);

    // 2. Loop through departments, get email, and ingest
    for (let i = 0; i < departments.length; i++) {
      const dept = departments[i];
      
      try {
        // Navigate to the individual department page to find the email
        await page.goto(dept.url, { waitUntil: 'domcontentloaded' });
        
        const email = await page.evaluate(() => {
          const mailto = document.querySelector('a[href^="mailto:"]');
          return mailto ? mailto.innerText.trim() : 'N/A';
        });

        const chunkContent = `Department: ${dept.department}\nLocation: ${dept.location}\nPhone: ${dept.phone}\nEmail: ${email}\nSource: ${dept.url}`;

        // 3. Generate actual OpenAI embeddings
        const embeddingResponse = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: chunkContent,
        });
        const embeddingVector = embeddingResponse.data[0].embedding;

        // 4. Insert into Documents Table
        const docInsertQuery = `
          INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING doc_id;
        `;
        const docResult = await client.query(docInsertQuery, [
          SOURCE_TITLE,
          dept.url,
          SOURCE_TYPE,
          i,
          chunkContent
        ]);
        const docId = docResult.rows[0].doc_id;

        // 5. Insert into DocumentEmbeddings Table
        const vectorString = `[${embeddingVector.join(',')}]`;
        const vectorInsertQuery = `
          INSERT INTO DocumentEmbeddings (doc_id, embedding)
          VALUES ($1, $2);
        `;
        await client.query(vectorInsertQuery, [docId, vectorString]);

        // Updated log to match library.js formatting
        console.log(`Inserted chunk ${i + 1}/${departments.length} into vector database.`);

      } catch (innerError) {
        console.error(`Error processing department ${dept.department}:`, innerError.message);
      }
    }

    console.log('Admin Directory data ingestion complete!');

  } catch (error) {
    console.error('Error during scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestAdmin();