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

const GOTO_TIMEOUT_MS = 60_000;

function parseMailtoAddress(href) {
  if (!href || typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed.toLowerCase().startsWith('mailto:')) return null;
  const addr = trimmed.slice('mailto:'.length).split('?')[0];
  try {
    const decoded = decodeURIComponent(addr).trim();
    return decoded || null;
  } catch {
    return addr.trim() || null;
  }
}

function isHttpUrl(href) {
  if (!href || typeof href !== 'string') return false;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function fetchDepartmentEmail(context, url) {
  const detailPage = await context.newPage();
  try {
    await detailPage.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: GOTO_TIMEOUT_MS,
    });
    return await detailPage.evaluate(() => {
      const mailto = document.querySelector('a[href^="mailto:"]');
      return mailto ? mailto.innerText.trim() : 'N/A';
    });
  } catch (err) {
    console.warn(`Could not load page for email lookup (${url}): ${err.message}`);
    return 'N/A';
  } finally {
    await detailPage.close().catch(() => {});
  }
}

async function scrapeAndIngestAdmin() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Admin Directory scrape with Playwright...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const listPage = await context.newPage();

    // Navigate to the main directory
    await listPage.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS });

    // 1. Extract all department links and basic info from the table
    const departments = await listPage.evaluate(() => {
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

    await listPage.close();

    if (departments.length === 0) {
      console.log('No directory data could be extracted from the page.');
      return;
    }

    console.log(`Found ${departments.length} departments. Generating embeddings and performing deep crawl...`);

    // 2. Loop through departments, get email, and ingest
    for (let i = 0; i < departments.length; i++) {
      const dept = departments[i];
      
      try {
        let email = 'N/A';
        const mailFromHref = parseMailtoAddress(dept.url);

        if (mailFromHref) {
          email = mailFromHref;
        } else if (isHttpUrl(dept.url)) {
          email = await fetchDepartmentEmail(context, dept.url);
        } else {
          console.warn(
            `Skipping deep crawl for ${dept.department}: unsupported URL scheme (${dept.url})`
          );
        }

        const chunkContent = `Department: ${dept.department}\nLocation: ${dept.location}\nPhone: ${dept.phone}\nEmail: ${email}\nSource: ${dept.url}`;

        // 3. Generate actual OpenAI embeddings
        const embeddingResponse = await openai.embeddings.create({
          model: embedModel, 
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