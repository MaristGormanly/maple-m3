const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });
const { Client } = require('pg');

const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

async function initializeDatabase() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL database.');

    // Ensure pgvector is enabled 
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    console.log('pgvector extension confirmed.');

    // ---------------------------------------------------------
    // 1. Relational Entities (Structured Data)
    // ---------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS Users (
        student_id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        major VARCHAR(255)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS CampusEvents (
        event_id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        location VARCHAR(255),
        start_time TIMESTAMP NOT NULL,
        category VARCHAR(100)
      );
    `);

    // ---------------------------------------------------------
    // 2. Knowledge Base & Vector Entities (Unstructured Data)
    // ---------------------------------------------------------
    // Includes all mandatory metadata fields required by the spec
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

    // Uses vector(1536) to match OpenAI text-embedding-3-small dimensions
    await client.query(`
      CREATE TABLE IF NOT EXISTS DocumentEmbeddings (
        embedding_id SERIAL PRIMARY KEY,
        doc_id INTEGER REFERENCES Documents(doc_id) ON DELETE CASCADE,
        embedding vector(768) 
      );
    `);

    // ---------------------------------------------------------
    // 3. Interaction Entities
    // ---------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS ChatHistory (
        chat_id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES Users(student_id) ON DELETE SET NULL,
        query_message TEXT NOT NULL,
        ai_response TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('All MAPLE M3 database tables successfully created!');

  } catch (error) {
    console.error('Error initializing database:', error);
  } finally {
    await client.end();
  }
}

initializeDatabase();