const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');
const { OpenAI } = require('openai');

let openai;
let embedModel;

// Logic to match your DGX Spark SSH tunnel or OpenAI fallback
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

// Initialize PostgreSQL Client
const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const SOURCE_TITLE = 'Marist Dining Hours & Menus';
const SOURCE_TYPE = 'Dining';
const BASE_DINING_URL = 'https://www.marist.edu/student-life/campus/dining';

// Hard-coded data for Cloudflare-protected pages
const diningData = [
  {
    location: "Murray Student Center Dining Hall",
    hours: "Mon-Fri: 7:00 AM - 9:00 PM; Sat-Sun: 9:00 AM - 8:00 PM",
    notes: "Main dining hall. Breakfast, lunch, and dinner are served daily.",
    menuLink: "https://marist.e-cater.com/index.php/login/catering_menus/"
  },
  {
    location: "Yella's (North End McCormick Hall)",
    hours: "Monday-Thursday: 11:00 AM - 11:00 PM; Friday-Sunday: 11:00 AM - 8:00 PM",
    notes: "Features Yella's sandwiches, burgers, chicken tenders, and seasonal milkshakes.",
    menuLink: "https://dineoncampus.com/marist/locations/yella-s"
  },
  {
    location: "Halal Shack (North End McCormick Hall)",
    hours: "Monday-Thursday: 11:00 AM - 10:00 PM; Friday: 11:00 AM - 8:00 PM",
    notes: "Features rice bowls and other Middle Eastern dishes.",
    menuLink: "https://dineoncampus.com/marist/locations/halal-shack"
  },
  {
    location: "York Street (North End McCormick Hall)",
    hours: "Monday-Thursday: 8:00 AM - 8:00 PM; Friday: 8:00 AM - 7:00 PM",
    notes: "Features sandwiches, soup, salads, and coffee.",
    menuLink: "https://dineoncampus.com/marist/locations/york-street"
  },
  {
    location: "Chef Jet (North End McCormick Hall)",
    hours: "Monday-Thursday: 4:00 PM - 9:00 PM; Friday: 12:00 AM - 8:00 PM",
    notes: "Features spring rolls and other Asian dishes.",
    menuLink: "https://dineoncampus.com/marist/locations/chef-jet"
  },
  {
    location: "Saxbys (Dyson Center)",
    hours: "Monday-Thursday: 7:00 AM - 7:00 PM; Friday: 8:00 AM - 4:00 PM; Saturday: 10:00 AM - 3:00 PM; Sunday: 10:00 AM - 2:00 PM",
    notes: "Features specialty coffee, smoothies, and breakfast sandwiches.",
    menuLink: "https://dineoncampus.com/marist/locations/saxbys"
  },
  {
    location: "Steel Plant Café",
    hours: "Mon-Fri: 10:00 AM - 3:00 PM",
    notes: "Specialty coffee, smoothies, and artisan sandwiches.",
    menuLink: "https://dineoncampus.com/marist/locations/steel-plant-cafe"
  },
  {
    location: "Donnelly Cafe (Rossi's)",
    hours: "Mon-Thu: 8:00 AM - 4:30 PM; Fri: 8:00 AM - 4:00 PM",
    notes: "Features Rossi's Deli sandwiches, soup, and snacks.",
    menuLink: "https://dineoncampus.com/marist/locations/donnelly-cafe"
  },
  {
    location: "Hudson at Hancock (Hancock Center)",
    hours: "Mon-Thu: 8:00 AM - 4:30 PM; Fri: 8:00 AM - 4:00 PM",
    notes: "Features Hudson at Hancock sandwiches, gluten free options, and specialty coffee.",
    menuLink: "https://dineoncampus.com/marist/locations/hudson-at-hancock"
  },
  {
    location: "Marketplace (Upper West Cedar)",
    hours: "Mon-Fri: 10:00 AM - 10:00 PM; Sat-Sun: 11:00 AM - 9:00 PM",
    notes: "Features breakfast, sandwiches, ice cream, and other snacks.",
    menuLink: "https://dineoncampus.com/marist/locations/marketplace"
  },
  {
    location: "Cabaret (Student Center)",
    hours: "Mon-Sun: 4:00 PM - 12:00 AM",
    notes: "Features tacos, buritos, french fries, and other snacks.",
    menuLink: "https://dineoncampus.com/marist/locations/cabaret"
  },
  {
    location: "Books and Beans / Starbucks (Library)",
    hours: "Mon-Fri: 7:00 AM - 3:00 PM",
    notes: "Features coffee, tea, and bagels.",
    menuLink: "https://dineoncampus.com/marist/locations/books-and-beans"
  },
  {
    location: "McCann Cafe (McCann Center)",
    hours: "Mon-Thur: 8:00 AM - 4:00 PM; Fri: 8:00 AM - 3:00 PM; Sat-Sun: 9:00 AM - 3:00 PM",
    notes: "Features breakfast food, sandwhiches, smoothies, and snacks.",
    menuLink: "https://dineoncampus.com/marist/locations/mccann-cafe"
  }
];

async function ingestDiningHours() {
  try {
    await client.connect();
    console.log(`Connected to database. Starting manual dining ingestion using ${embedModel}...`);

    for (let i = 0; i < diningData.length; i++) {
      const entry = diningData[i];
      
      const chunkContent = `
        Location: ${entry.location}
        Hours: ${entry.hours}
        Details: ${entry.notes}
        Menu & More Info: ${entry.menuLink}
      `.trim();

      // Generate Embedding (Ollama or OpenAI)
      const embeddingResponse = await openai.embeddings.create({
        model: embedModel,
        input: chunkContent,
      });
      const embeddingVector = embeddingResponse.data[0].embedding;

      // Insert into Documents Table
      const docInsertQuery = `
        INSERT INTO Documents (source_title, source_url, source_type, chunk_index, content)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING doc_id;
      `;
      const docResult = await client.query(docInsertQuery, [
        SOURCE_TITLE,
        entry.menuLink,
        SOURCE_TYPE,
        i,
        chunkContent
      ]);
      const docId = docResult.rows[0].doc_id;

      // Insert into DocumentEmbeddings Table
      const vectorString = `[${embeddingVector.join(',')}]`;
      const vectorInsertQuery = `
        INSERT INTO DocumentEmbeddings (doc_id, embedding)
        VALUES ($1, $2);
      `;
      await client.query(vectorInsertQuery, [docId, vectorString]);

      console.log(`Inserted chunk ${i + 1}/${diningData.length} into vector database.`);
    }

    console.log('Dining data ingestion complete!');

  } catch (error) {
    console.error('Error during manual ingestion:', error);
  } finally {
    await client.end();
  }
}

ingestDiningHours();