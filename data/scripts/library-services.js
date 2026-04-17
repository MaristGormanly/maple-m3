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

// Constants from Spec Document
const SOURCE_URL = 'https://marist.libanswers.com/search/';
const SOURCE_TITLE = 'Marist Library FAQs';
const SOURCE_TYPE = 'Library';

async function scrapeLibraryFAQs() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting Library FAQ deep crawl...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ 
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // Navigate to the main directory
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for the search result list container
    console.log('Waiting for search results list to load...');
    await page.waitForSelector('#s-srch-results-0', { timeout: 20000 });

    // Extract FAQ links from the search results
    const faqLinks = await page.evaluate(() => {
      const linkElements = Array.from(document.querySelectorAll('.s-srch-result-title a'));
      return linkElements.map(a => ({
        title: a.innerText.trim(),
        url: a.href
      })).filter(link => link.url.includes('/faq/'));
    });

    if (faqLinks.length === 0) {
      console.log('No FAQ links found. Verify selectors or search state.');
      return;
    }

    console.log(`Found ${faqLinks.length} FAQ entries. Starting deep crawl for metadata...`);

    for (let i = 0; i < faqLinks.length; i++) {
      const faq = faqLinks[i];
      const detailPage = await context.newPage();
      
      try {
        console.log(`[Deep Crawl ${i + 1}/${faqLinks.length}] Visiting: ${faq.title}`);
        await detailPage.goto(faq.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const faqData = await detailPage.evaluate(() => {
          // Updated Answer Selector: targeting .s-la-faq-answer-body as per the DOM breakdown
          const question = document.querySelector('.s-la-faq-q-title, #s-la-content-header h1')?.innerText.trim();
          const answer = document.querySelector('.s-la-faq-answer-body')?.innerText.trim();
          
          // Metadata extraction
          const lastUpdated = document.querySelector('.s-la-faq-meta, .s-la-faq-last-update')?.innerText.replace('Last Updated:', '').trim();
          const staff = document.querySelector('.s-la-faq-owner, .s-la-faq-author')?.innerText.trim();
          const topics = Array.from(document.querySelectorAll('.s-la-faq-topics a, .s-la-faq-topic-list a'))
            .map(t => t.innerText.trim());

          return { question, answer, lastUpdated, staff, topics };
        });

        // Transform into structured JSON (Design Doc requirement for reducing hallucinations)
        const chunkContent = JSON.stringify({
          question: faqData.question || faq.title,
          answer_text: faqData.answer || "Answer content not found at the expected selector.",
          metadata: {
            topics: faqData.topics,
            last_updated: faqData.lastUpdated,
            answered_by: faqData.staff,
            source_url: faq.url
          }
        });

        // Generate embeddings for the unified chunk
        const embeddingResponse = await openai.embeddings.create({
          model: embedModel, 
          input: chunkContent,
        });
        const embeddingVector = embeddingResponse.data[0].embedding;

        // Insert into Documents Table (Relational Entity)
        const docInsertQuery = `
          INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content, last_updated)
          VALUES ($1, $2, $3, $4, $5, NOW())
          RETURNING doc_id;
        `;
        const docResult = await client.query(docInsertQuery, [
          SOURCE_TITLE,
          faq.url,
          SOURCE_TYPE,
          i,
          chunkContent
        ]);
        const docId = docResult.rows[0].doc_id;

        // Insert into DocumentEmbeddings Table (Vector Entity)
        const vectorString = `[${embeddingVector.join(',')}]`;
        const vectorInsertQuery = `
          INSERT INTO DocumentEmbeddings (doc_id, embedding)
          VALUES ($1, $2);
        `;
        await client.query(vectorInsertQuery, [docId, vectorString]);

        console.log(`Successfully ingested: ${faq.title}`);

      } catch (innerError) {
        console.error(`Error processing FAQ ${faq.url}:`, innerError.message);
      } finally {
        await detailPage.close().catch(() => {});
      }
    }

    console.log('Library FAQ ingestion complete!');

  } catch (error) {
    console.error('Fatal Error during scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeLibraryFAQs();