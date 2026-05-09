/**
 * server/src/index.js — Application Entry Point
 *
 * Bootstraps the MAPLE M3 Express server. Responsibilities:
 *  - Loads environment variables from .env via dotenv
 *  - Registers global middleware (JSON body parsing, CORS)
 *  - Mounts the /api/v1/campus route group and the top-level /health liveness endpoint
 *  - Waits for the PostgreSQL connection pool (retrieval service) to be ready before
 *    opening the HTTP port, so the server never accepts traffic before the DB is available
 *
 * Start: `npm run start` (from server/) or `node src/index.js`
 * Default port: 3000 (overridable via PORT env var)
 */
const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { corsMiddleware } = require('./middleware/security');
const campusRoutes = require('./routes/campus');
const retrievalService = require('./services/retrieval');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(corsMiddleware);

app.get('/health', async (req, res) => {
  try {
    const pool = retrievalService.getDbPool();
    await pool.query('SELECT 1'); 
    res.status(200).json({ status: 'healthy', message: 'MAPLE M3 API is running.' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'DB connection failed.' });
  }
});

app.use('/api/v1/campus', campusRoutes);

async function startServer() {
  try {
    // Await DB readiness before opening the port
    await retrievalService.connectDB();
    
    app.listen(PORT, () => {
      console.log(`===================================================`);
      console.log(`🍁 MAPLE M3 Backend running on http://localhost:${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`===================================================`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();