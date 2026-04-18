const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const { chromium } = require('playwright');
const { OpenAI } = require('openai');

/**
 * MAPLE M3 Library Deep Crawl
 * This script discovers FAQ links across all specified LibGuide hubs
 * and performs a deep extraction of each Q&A pair.
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

// Full list of LibGuide pages to scan for FAQ widgets
const TARGET_GUIDES = [
  'https://libguides.marist.edu/students',
  'https://libguides.marist.edu/c.php?g=87344&p=8830695',
  'https://libguides.marist.edu/c.php?g=87344&p=8830703',
  'https://libguides.marist.edu/c.php?g=87344&p=8830706',
  'https://libguides.marist.edu/c.php?g=87344&p=8830702',
  'https://libguides.marist.edu/citation',
  'https://libguides.marist.edu/plagiarism'
];

const SOURCE_TITLE = 'Marist Library FAQs';
const SOURCE_TYPE = 'Library';

async function scrapeLibraryFAQs() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Initializing Discovery Phase...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const discoveryPage = await context.newPage();

    let allFaqLinks = [];

    // PHASE 1: Discovery - Collect links pointing to /faq/ from all target hubs
    for (const url of TARGET_GUIDES) {
      console.log(`Scanning Hub: ${url}`);
      try {
        // Use 'networkidle' to ensure dynamic widgets have finished fetching data
        await discoveryPage.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        
        // Wait for any link containing '/faq/' to appear, allowing for 15s delay
        await discoveryPage.waitForSelector('a[href*="/faq/"]', { timeout: 15000 }).catch(() => {
          console.log(`Warning: No FAQ links detected on ${url} within timeout.`);
        });

        const links = await discoveryPage.evaluate(() => {
          // Broadly target all anchors that link to an FAQ sub-page
          const anchorElements = Array.from(document.querySelectorAll('a[href*="/faq/"]'));
          return anchorElements.map(a => ({
            title: a.innerText.trim(),
            url: a.href
          })).filter(link => link.title.length > 0);
        });
        
        allFaqLinks.push(...links);
        console.log(`Successfully found ${links.length} potential FAQs on ${url}`);
      } catch (e) {
        console.error(`Discovery Phase encountered an error on ${url}: ${e.message}`);
      }
    }

    // Deduplicate discovered URLs to prevent redundant API calls and database entries
    const uniqueFaqList = Array.from(new Set(allFaqLinks.map(f => f.url)))
      .map(url => allFaqLinks.find(f => f.url === url));

    console.log(`Discovery Phase Complete. ${uniqueFaqList.length} unique FAQs queued for Deep Extraction.`);

    // PHASE 2: Extraction - Visit each unique FAQ detail page
    for (let i = 0; i < uniqueFaqList.length; i++) {
      const faq = uniqueFaqList[i];
      const detailPage = await context.newPage();
      
      try {
        console.log(`[Deep Crawl ${i + 1}/${uniqueFaqList.length}] Extracting: ${faq.title}`);
        await detailPage.goto(faq.url, { waitUntil: 'domcontentloaded' });

        const faqData = await detailPage.evaluate(() => {
          // Extraction logic based on the LibAnswers detail page structure
          const question = document.querySelector('.s-la-faq-q-title, #s-la-content-header h1')?.innerText.trim();
          const answer = document.querySelector('.s-la-faq-answer-body')?.innerText.trim();
          const lastUpdated = document.querySelector('.s-la-faq-meta, .s-la-faq-last-update')?.innerText.replace('Last Updated:', '').trim();

          return { question, answer, lastUpdated };
        });

        if (!faqData.answer) {
          console.log(`Skipping ${faq.url}: No visible answer content found.`);
          continue;
        }

        // Map data to the MAPLE M3 JSON structure
        const chunkContent = JSON.stringify({
          question: faqData.question || faq.title,
          answer_text: faqData.answer,
          metadata: {
            source_url: faq.url,
            last_updated: faqData.lastUpdated,
            source_type: 'Library FAQ'
          }
        });

        // Generate vector embeddings for the RAG pipeline
        const embeddingResponse = await openai.embeddings.create({
          model: embedModel, 
          input: chunkContent,
        });
        const embeddingVector = embeddingResponse.data[0].embedding;

        // Insert into the relational 'Documents' table
        const docResult = await client.query(`
          INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content, last_updated)
          VALUES ($1, $2, $3, $4, $5, NOW())
          RETURNING doc_id;
        `, [SOURCE_TITLE, faq.url, SOURCE_TYPE, i, chunkContent]);
        
        const docId = docResult.rows[0].doc_id;

        // Insert into the 'DocumentEmbeddings' vector store
        const vectorString = `[${embeddingVector.join(',')}]`;
        await client.query(`
          INSERT INTO DocumentEmbeddings (doc_id, embedding) 
          VALUES ($1, $2);
        `, [docId, vectorString]);

      } catch (innerError) {
        console.error(`Deep Extraction failed for FAQ ${faq.url}:`, innerError.message);
      } finally {
        await detailPage.close();
      }
    }

    console.log('Library FAQ Ingestion and Vectorization completed successfully.');

  } catch (error) {
    console.error('Fatal Error during scraping/ingestion:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeLibraryFAQs();