const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const { chromium } = require('playwright');
const { OpenAI } = require('openai');

/**
 * MAPLE M3 Configuration
 * Supports local DGX Spark (Ollama) or OpenAI frontier models
 */
const USE_LOCAL = process.env.USE_LOCAL_MODEL === 'true';
const openai = new OpenAI({
  baseURL: USE_LOCAL ? 'http://localhost:11434/v1' : undefined,
  apiKey: USE_LOCAL ? 'ollama' : process.env.OPENAI_API_KEY,
});

const embedModel = USE_LOCAL ? 'nomic-embed-text' : 'text-embedding-3-small';

const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const SOURCE_URL = 'https://library.marist.edu/web/marist-library/hours-full';
const SOURCE_TITLE = 'Marist Library Hours';
const SOURCE_TYPE = 'Library';

async function scrapeLibraryCalendar() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Library Hours deep crawl...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const iframeSelector = 'iframe[src*="libcal"], iframe[src*="calendar.google.com"]';
    console.log('Locating hours iframe...');
    
    await page.waitForSelector(iframeSelector, { timeout: 20000 });
    const frame = page.frameLocator(iframeSelector);

    let hoursData = [];

    try {
      // Attempt structured table extraction first
      await frame.locator('table').first().waitFor({ timeout: 10000 });
      hoursData = await frame.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr'));
        return rows.map(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          return cells.length >= 2 ? {
            area: cells[0].innerText.trim(),
            hours: cells[1].innerText.trim()
          } : null;
        }).filter(item => item && item.area !== "" && !item.area.includes('Building'));
      });
    } catch (e) {
      // Fallback strategy for unstructured calendar text
      console.log('Table not found, performing raw text extraction...');
      const rawText = await frame.locator('body').innerText();
      // Split by specific date patterns or treat as one large chunk
      hoursData = [{ area: "General Library Building", hours: rawText.trim() }];
    }

    console.log(`Processing ${hoursData.length} records...`);

    for (let i = 0; i < hoursData.length; i++) {
      const entry = hoursData[i];

      // 1. DATA CLEANING: Remove Google Calendar UI noise
      const cleanHours = entry.hours
        .replace(/1 event, /gi, '')
        .replace(/All day, /gi, '')
        .replace(/Calendar: Library Hours.*/gi, '')
        .replace(/Send feedback to Google.*/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      // 2. NICE FORMATTING: Create a semantic template for the LLM
      const chunkContent = [
        `Location/Area: ${entry.area}`,
        `Date Context: ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
        `Operating Hours: ${cleanHours}`,
        `Source: ${SOURCE_URL}`,
        `Last Verified: ${new Date().toISOString()}`
      ].join('\n');

      // 3. GENERATE EMBEDDINGS
      const embeddingResponse = await openai.embeddings.create({
        model: embedModel,
        input: chunkContent,
      });
      const embeddingVector = embeddingResponse.data[0].embedding;

      // 4. INSERT INTO DATABASE
      const docResult = await client.query(`
        INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING doc_id;
      `, [SOURCE_TITLE, SOURCE_URL, SOURCE_TYPE, i, chunkContent]);

      await client.query(`
        INSERT INTO DocumentEmbeddings (doc_id, embedding)
        VALUES ($1, $2);
      `, [docResult.rows[0].doc_id, `[${embeddingVector.join(',')}]`]);

      console.log(`Inserted nicely formatted chunk for: ${entry.area}`);
    }

    console.log('Library Hours ingestion complete!');

  } catch (err) {
    console.error('Critical Error:', err);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeLibraryCalendar();