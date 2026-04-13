const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });
const { Pool } = require('pg'); 

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

async function initializeDatabase() {
  try {
    const client = await pool.connect();
    console.log('Connected to PostgreSQL database.');

    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    console.log('pgvector extension confirmed.');

    const embedDim = process.env.USE_LOCAL_MODEL === 'true' ? 768 : 1536;
    console.log(`Target vector dimension: ${embedDim}`);

    // Explicit RESET_DB environment variable handling to rebuild schema
    if (process.env.RESET_DB === 'true') {
      console.log('RESET_DB is true. Dropping existing tables to rebuild schema...');
      await client.query('DROP TABLE IF EXISTS ChatHistory, DocumentEmbeddings, Documents, Users CASCADE;');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS Users (
        student_id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        major VARCHAR(255)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS Documents (
        doc_id SERIAL PRIMARY KEY,
        source_title VARCHAR(255) NOT NULL,
        source_url VARCHAR(255) NOT NULL,
        source_type VARCHAR(100) NOT NULL,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL
      );
    `);

    // Dynamically set vector dimension
    await client.query(`
      CREATE TABLE IF NOT EXISTS DocumentEmbeddings (
        embedding_id SERIAL PRIMARY KEY,
        doc_id INTEGER REFERENCES Documents(doc_id) ON DELETE CASCADE,
        embedding vector(${embedDim}) 
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ChatHistory (
        chat_id SERIAL PRIMARY KEY,
        conversation_id VARCHAR(255) NOT NULL,
        student_id INTEGER REFERENCES Users(student_id) ON DELETE SET NULL,
        query_message TEXT NOT NULL,
        ai_response TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('All MAPLE M3 database tables successfully created/verified!');
    client.release();

  } catch (error) {
    console.error('Error initializing database:', error);
  } finally {
    await pool.end();
  }
}

initializeDatabase();