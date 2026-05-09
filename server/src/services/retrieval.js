/**
 * server/src/services/retrieval.js — Vector Retrieval Service
 *
 * Manages the PostgreSQL connection pool and performs vector similarity search
 * against the DocumentEmbeddings table. This is the AI integration point for
 * the RAG retrieval phase — future optimizations (re-ranking, hybrid search) plug in here.
 *
 * Key responsibilities:
 *  - Initializes a pg.Pool (max 10 connections) for safe concurrent request handling
 *  - Exports getDbPool() so other modules (routes, controllers) can share the same pool
 *    without opening duplicate connections
 *  - search(query, domainFilter, conversationId):
 *      1. Embeds the query string via the configured embedding model
 *         (nomic-embed-text via Ollama on DGX Spark, or text-embedding-3-small via OpenAI,
 *          selected by the USE_LOCAL_MODEL environment variable)
 *      2. Runs a pgvector cosine similarity query against DocumentEmbeddings JOIN Documents
 *      3. Applies an optional source_type filter (domainFilter) to isolate the search
 *         to a single data domain (Library, Dining, IT, etc.)
 *      4. Filters results to a similarity threshold of 0.55 and returns the top 5 chunks
 *      5. Logs retrieval metadata (chunks retrieved, top/min scores, threshold) via logger
 *
 * Embedding model dimensions:
 *  - Local (USE_LOCAL_MODEL=true):  768 dims  (nomic-embed-text via Ollama)
 *  - Cloud (USE_LOCAL_MODEL=false): 1536 dims (text-embedding-3-small via OpenAI)
 * The DocumentEmbeddings table dimension must match — see models/db/init.js.
 */
const { OpenAI } = require('openai');
const { Pool } = require('pg'); 
const logger = require('../utils/logger');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

let openai;
let embedModel;
if (process.env.USE_LOCAL_MODEL === 'true') {
  openai = new OpenAI({ baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' });
  embedModel = 'nomic-embed-text';
} else {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  embedModel = 'text-embedding-3-small';
}

// Initializing a connection pool to handle concurrent Express requests safely
const dbPool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  max: 10, // Max number of clients in the pool
  idleTimeoutMillis: 30000
});

const retrievalService = {
  async connectDB() {
    try {
      // Test the pool connection
      const client = await dbPool.connect();
      console.log('Retrieval Service connected to PostgreSQL Pool.');
      client.release();
    } catch (err) {
      console.error('Retrieval Service DB Pool Error:', err);
      throw err;
    }
  },

  getDbPool: () => dbPool, // Export the pool

  async search(query, domainFilter = null, conversationId = 'unknown') {
    const SIMILARITY_THRESHOLD = 0.55; 
    const TOP_K = 5;
    const startTime = Date.now();

    try {
      const embeddingResponse = await openai.embeddings.create({
        model: embedModel,
        input: query,
      });
      const vectorString = `[${embeddingResponse.data[0].embedding.join(',')}]`;

      let filterSql = '';
      const queryParams = [vectorString, SIMILARITY_THRESHOLD, TOP_K];
      
      if (domainFilter) {
        filterSql = `AND d.source_type = $4`;
        queryParams.push(domainFilter);
      }

      const searchQuery = `
        SELECT 
          d.doc_id, d.chunk_index, d.source_title, d.source_url, d.source_type, d.last_updated, d.content,
          (1 - (e.embedding <=> $1::vector)) AS relevance_score
        FROM DocumentEmbeddings e
        JOIN Documents d ON e.doc_id = d.doc_id
        WHERE (1 - (e.embedding <=> $1::vector)) >= $2 ${filterSql}
        ORDER BY relevance_score DESC
        LIMIT $3;
      `;

      // Run query against the pool
      const result = await dbPool.query(searchQuery, queryParams);
      const chunks = result.rows;

      const topScore = chunks.length > 0 ? parseFloat(chunks[0].relevance_score) : null;
      const minScore = chunks.length > 0 ? parseFloat(chunks[chunks.length - 1].relevance_score) : null;

      logger.logRetrieval({
        conversation_id: conversationId,
        query: query,
        model: embedModel,
        chunks_retrieved: chunks.length,
        top_score: topScore,
        min_score: minScore,
        threshold_applied: SIMILARITY_THRESHOLD,
        latency_ms: Date.now() - startTime,
        success: true,
        error: null
      });

      return {
        success: true,
        chunks: chunks,
        metadata: { chunks_retrieved: chunks.length, top_score: topScore, min_score: minScore, threshold_applied: SIMILARITY_THRESHOLD }
      };

    } catch (error) {
      logger.logRetrieval({
        conversation_id: conversationId,
        query: query,
        model: embedModel,
        chunks_retrieved: 0,
        top_score: null,
        min_score: null,
        threshold_applied: SIMILARITY_THRESHOLD,
        latency_ms: Date.now() - startTime,
        success: false,
        error: error.message
      });
      return {
        success: false,
        chunks: [],
        error: error.message || 'Database retrieval failed',
        metadata: {
          chunks_retrieved: 0,
          top_score: null,
          min_score: null,
          threshold_applied: SIMILARITY_THRESHOLD
        }
      };
    }
  }
};

module.exports = retrievalService;