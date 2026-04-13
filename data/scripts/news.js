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

const SOURCE_URL = 'https://www.maristcircle.com/home';
const SOURCE_TITLE = 'Marist Circle — Campus News';
const SOURCE_TYPE = 'News';

const GOTO_TIMEOUT_MS = 60_000;

async function scrapeAndIngestNews() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Marist Circle campus news scrape with Playwright...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS });
    await page.waitForSelector('article.BlogList-item', { timeout: 15000 });

    const articles = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('article.BlogList-item'));
      return items
        .map(item => {
          const titleEl = item.querySelector('a.BlogList-item-title');
          const authorEl = item.querySelector('a.Blog-meta-item--author');
          const dateEl = item.querySelector('time.Blog-meta-item--date');
          const iso = dateEl?.getAttribute('datetime')?.trim() || null;
          const dateText = dateEl?.innerText.trim() || null;
          return {
            article_title: titleEl ? titleEl.innerText.trim() : null,
            author: authorEl ? authorEl.innerText.trim() : null,
            date: iso || dateText,
            article_url: titleEl ? titleEl.href : null,
          };
        })
        .filter(a => a.article_title);
    });

    await page.close();

    if (articles.length === 0) {
      console.log('No campus news articles could be extracted from the page.');
      return;
    }

    console.log(`Successfully extracted ${articles.length} articles. Generating embeddings...`);

    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const chunkContent = [
        `article_title: ${article.article_title}`,
        `author: ${article.author ?? 'N/A'}`,
        `date: ${article.date ?? 'N/A'}`,
        `url: ${article.article_url ?? SOURCE_URL}`,
      ].join('\n');

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
        const docResult = await client.query(docInsertQuery, [
          SOURCE_TITLE,
          article.article_url || SOURCE_URL,
          SOURCE_TYPE,
          i,
          chunkContent,
        ]);
        const docId = docResult.rows[0].doc_id;

        const vectorInsertQuery = `
          INSERT INTO DocumentEmbeddings (doc_id, embedding)
          VALUES ($1, $2);
        `;
        await client.query(vectorInsertQuery, [docId, `[${embeddingVector.join(',')}]`]);

        console.log(`Inserted chunk ${i + 1}/${articles.length} into vector database.`);
      } catch (innerError) {
        console.error(`Failed to ingest article: ${article.article_title}`, innerError.message);
      }
    }

    console.log('Marist Circle news ingestion complete!');
  } catch (error) {
    console.error('Error during scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestNews();
