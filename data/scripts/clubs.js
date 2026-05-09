const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const { chromium } = require('playwright');
const { OpenAI } = require('openai');

let openai;
let embedModel;

if (process.env.USE_LOCAL_MODEL === 'true') {
  openai = new OpenAI({ baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' });
  embedModel = 'nomic-embed-text'; 
} else {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  embedModel = 'text-embedding-3-small'; 
}

const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const SOURCE_URL = 'https://www.marist.edu/student-life/involvement';
const SOURCE_TITLE = 'Marist Student Organizations Directory';
const SOURCE_TYPE = 'Clubs';

async function scrapeAndIngestClubs() {
  let browser;
  try {
    await client.connect();
    console.log('Connected to database. Starting multi-pass aggregate scrape...');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const listPage = await context.newPage();

    await listPage.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const clubData = await listPage.evaluate(() => {
      const results = [];
      const seenNames = new Set();

      // PASS 1: The three-column list section
      const allH2s = Array.from(document.querySelectorAll('h2'));
      const mainHeader = allH2s.find(h => h.innerText.includes('Clubs and Organizations:'));
      if (mainHeader) {
        const container = mainHeader.closest('section') || mainHeader.parentElement;
        const categories = Array.from(container.querySelectorAll('h3'));
        categories.forEach(catHeader => {
          const categoryName = catHeader.innerText.trim();
          let nextEl = catHeader.nextElementSibling;
          while (nextEl && nextEl.tagName !== 'H3') {
            const foundLists = nextEl.tagName === 'UL' ? [nextEl] : Array.from(nextEl.querySelectorAll('ul'));
            foundLists.forEach(list => {
              Array.from(list.querySelectorAll('li')).forEach(li => {
                const name = li.innerText.trim();
                if (name && !seenNames.has(name) && !name.includes('Related Links')) {
                  const link = li.querySelector('a');
                  results.push({ name, category: categoryName, url: link ? link.href : null });
                  seenNames.add(name);
                }
              });
            });
            nextEl = nextEl.nextElementSibling;
          }
        });
      }

      // PASS 2: The Accordion section (Captures the previously missing Sports)
      const allH1s = Array.from(document.querySelectorAll('h1'));
      const involvementHeader = allH1s.find(h => h.innerText.includes('Involvement Opportunities'));
      if (involvementHeader) {
        const accordionContainer = involvementHeader.closest('.journal-content-article') || document.body;
        const accordionCategories = Array.from(accordionContainer.querySelectorAll('.collapse-header-text'));
        accordionCategories.forEach(catHeader => {
          const categoryName = catHeader.innerText.trim();
          const parentCard = catHeader.closest('.collapse-card');
          const panel = parentCard?.querySelector('.collapse');
          if (panel) {
            Array.from(panel.querySelectorAll('li')).forEach(li => {
              const name = li.innerText.trim();
              if (name && !seenNames.has(name)) {
                const link = li.querySelector('a');
                results.push({ name, category: categoryName, url: link ? link.href : null });
                seenNames.add(name);
              }
            });
          }
        });
      }
      return results;
    });

    console.log(`Identified ${clubData.length} unique clubs. Starting deep aggregate extraction...`);

    for (let i = 0; i < clubData.length; i++) {
      const club = clubData[i];
      let clubText = "Status: This club exists but has no additional info page.";

      if (club.url && club.url.startsWith('http') && !club.url.includes('mailto:')) {
        const detailPage = await context.newPage();
        try {
          console.log(`[Crawl] ${club.name}`);
          await detailPage.goto(club.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          clubText = await detailPage.evaluate(() => {
            // 1. CLEANUP: Remove global navigation and footer elements
            const bloat = [
                'header', 'footer', '#header-navigation-bar', 
                '#mobile-header-navigation', '.navbar', '#scrape-alert', 
                '.sr-only', '.modal', '.dropdown-menu', 
                '[id^="desktop-modal-"]', '[id^="mobile-modal-"]'
            ];
            bloat.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()));

            // 2. AGGREGATE CONTENT: 
            // Instead of picking the FIRST fragment, we find ALL content fragments
            // and combine them, specifically looking for the bio text.
            const contentSelectors = ['section.basic-text', '.journal-content-article', '#main-content'];
            let collectedText = "";

            contentSelectors.forEach(selector => {
                const elements = Array.from(document.querySelectorAll(selector));
                elements.forEach(el => {
                    const text = el.innerText.trim();
                    // FILTER: Ignore fragments that are just short navigation buttons (e.g., "Sign Up")
                    if (text.length > 20 && !collectedText.includes(text)) {
                        collectedText += text + "\n\n";
                    }
                });
            });

            return collectedText.length > 0 ? collectedText : "No descriptive text found.";
          });
          
          clubText = clubText.substring(0, 4000); // Increased limit for fuller bios

        } catch (e) {
          clubText = "Status: Page could not be reached.";
        } finally {
          await detailPage.close();
        }
      }

      const finalContent = `Club: ${club.name}\nCategory: ${club.category}\nInfo: ${clubText}\nSource: ${club.url || SOURCE_URL}`;
      const cleanContent = finalContent.replace(/[^\x00-\x7F]/g, " ").replace(/\s+/g, ' ').trim();

      try {
        const embeddingResponse = await openai.embeddings.create({ model: embedModel, input: cleanContent });
        const vector = `[${embeddingResponse.data[0].embedding.join(',')}]`;

        const docInsertQuery = `
          INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content)
          VALUES ($1, $2, $3, $4, $5) RETURNING doc_id;
        `;
        const docRes = await client.query(docInsertQuery, [SOURCE_TITLE, club.url || SOURCE_URL, SOURCE_TYPE, i, cleanContent]);
        
        const vectorInsertQuery = `INSERT INTO DocumentEmbeddings (doc_id, embedding) VALUES ($1, $2);`;
        await client.query(vectorInsertQuery, [docRes.rows[0].doc_id, vector]);

      } catch (dbErr) {
        console.error(`DB Error on ${club.name}:`, dbErr.message);
      }
    }
    console.log('Ingestion complete!');
  } catch (error) {
    console.error('Fatal Error:', error);
  } finally {
    if (browser) await browser.close();
    await client.end();
  }
}

scrapeAndIngestClubs();