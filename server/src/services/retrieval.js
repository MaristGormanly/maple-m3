const { OpenAI } = require('openai');
const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Point directly to the DGX Spark via your local SSH tunnel
const openai = new OpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama', 
});

// Initialize PostgreSQL Client
const dbClient = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Connect to the DB once when the service loads
dbClient.connect().catch(err => console.error('Retrieval Service DB Connection Error:', err));

const retrievalService = {
  /**
   * Embeds a query and retrieves the top matching document chunks from PostgreSQL.
   * @param {string} query - The student's question
   * @returns {Object} { chunks: Array, metadata: Object }
   */
  async search(query) {
    const SIMILARITY_THRESHOLD = 0.70; // Mandated guardrail
    const TOP_K = 5; // Mandated default limit

    try {
      // 1. Generate the vector for the user's query using the local model
      const embeddingResponse = await openai.embeddings.create({
        model: 'nomic-embed-text', // 768-dimension local model
        input: query,
      });
      const queryVector = embeddingResponse.data[0].embedding;
      const vectorString = `[${queryVector.join(',')}]`;

      // 2. Perform Cosine Similarity Search in PostgreSQL
      // pgvector uses `<=>` for cosine distance. Cosine Similarity = 1 - Cosine Distance.
      const searchQuery = `
        SELECT 
          d.source_title, 
          d.source_url, 
          d.source_type, 
          d.content,
          d.doc_id,
          (1 - (e.embedding <=> $1::vector)) AS relevance_score
        FROM DocumentEmbeddings e
        JOIN Documents d ON e.doc_id = d.doc_id
        WHERE (1 - (e.embedding <=> $1::vector)) >= $2
        ORDER BY relevance_score DESC
        LIMIT $3;
      `;

      const result = await dbClient.query(searchQuery, [vectorString, SIMILARITY_THRESHOLD, TOP_K]);
      const chunks = result.rows;

      // 3. Extract logging metrics for the controller 
      const topScore = chunks.length > 0 ? parseFloat(chunks[0].relevance_score).toFixed(4) : null;
      const minScore = chunks.length > 0 ? parseFloat(chunks[chunks.length - 1].relevance_score).toFixed(4) : null;

      return {
        success: true,
        chunks: chunks,
        metadata: {
          chunks_retrieved: chunks.length,
          top_score: topScore,
          min_score: minScore,
          threshold_applied: SIMILARITY_THRESHOLD
        }
      };

    } catch (error) {
      console.error('[Retrieval Service Error]:', error);
      return {
        success: false,
        chunks: [],
        error: 'Database retrieval failed'
      };
    }
  }
};

module.exports = retrievalService;