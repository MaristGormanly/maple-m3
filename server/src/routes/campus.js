/**
 * server/src/routes/campus.js — Campus API Route Definitions
 *
 * Defines and exports all Express routes under the /api/v1/campus prefix.
 * Route handlers are kept thin — business logic lives in the controller and services.
 *
 * Registered endpoints:
 *  POST /chat    → chat controller (RAG pipeline, rate-limited)
 *  GET  /status  → inline handler; queries Documents for source_type='Events' and
 *                  returns up to 10 formatted event records (supports ?date= filtering)
 *  POST /ingest  → inline handler; triggers the admin-directory.js scraping script
 *                  asynchronously and returns a 202 with a job ID (MVP: Admin only)
 *
 * Note: /ingest accepts only source_type='Admin' for the Lab 2 MVP. All other domain
 * ingestion is run directly via the scripts in data/scripts/.
 */
const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const path = require('path');
const { handleChat } = require('../controllers/chat');
const { apiLimiter, requireAdminToken } = require('../middleware/security');
const retrievalService = require('../services/retrieval');

// Helper to extract structured event data from the raw scraped text chunks
function mapEventDocumentRow(row) {
  const content = row.content || '';
  const titleMatch = content.match(/^Event:\s*(.+)$/m);
  const locationMatch = content.match(/^Location:\s*(.+)$/m);
  return {
    title: titleMatch ? titleMatch[1].trim() : row.source_title,
    location: locationMatch ? locationMatch[1].trim() : 'Campus', // Fallback
    start_time: row.last_updated,
    category: 'Events',
  };
}

router.post('/chat', apiLimiter, handleChat);

// Fetch event chunks from Documents (source_type = 'Events')
router.get('/status', async (req, res) => {
  const timestamp = new Date().toISOString();
  try {
    const { date } = req.query; // filters by ingest date (last_updated), e.g. ?date=2026-04-15
    const pool = retrievalService.getDbPool();
    
    let queryText = '';
    let queryParams = [];

    if (date) {
      queryText = `
        SELECT doc_id, source_title, source_url, source_type, last_updated, content
        FROM Documents
        WHERE source_type = 'Events' AND DATE(last_updated) = $1::date
        ORDER BY last_updated DESC
        LIMIT 10;
      `;
      queryParams.push(date);
    } else {
      queryText = `
        SELECT doc_id, source_title, source_url, source_type, last_updated, content
        FROM Documents
        WHERE source_type = 'Events'
        ORDER BY last_updated DESC
        LIMIT 10;
      `;
    }

    const result = await pool.query(queryText, queryParams);

    const formattedEvents = result.rows.map(mapEventDocumentRow);

    res.status(200).json({
      success: true,
      data: formattedEvents,
      error: null,
      metadata: { timestamp, module: "m3", version: "1.0.0" }
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      data: null, 
      error: { code: 'INTERNAL_ERROR', message: 'Database query failed: ' + err.message },
      metadata: { timestamp, module: "m3", version: "1.0.0" }
    });
  }
});

// Trigger actual data ingestion pipeline script (Admin token required)
router.post('/ingest', requireAdminToken, (req, res) => {
  const timestamp = new Date().toISOString();
  const { source_type } = req.body;
  
  if (source_type !== 'Admin') {
    return res.status(400).json({ 
      success: false, 
      data: null, 
      error: { code: 'VALIDATION_ERROR', message: "Only 'Admin' source ingestion is supported via API for MVP." },
      metadata: { timestamp, module: "m3", version: "1.0.0" }
    });
  }

  const jobId = `job_${Date.now()}`;
  const scriptPath = path.join(__dirname, '../../../data/scripts/admin-directory.js');
  
  // Trigger the script asynchronously (pseudo job-tracking)
  console.log(`[Ingest Job Started] ID: ${jobId}`);
  exec(`node ${scriptPath}`, (error, stdout, stderr) => {
    if (error) console.error(`[Ingest Job Failed] ID: ${jobId} | Error: ${error.message}`);
    if (stderr) console.error(`[Ingest Job Stderr] ID: ${jobId} | ${stderr}`);
    console.log(`[Ingest Job Completed] ID: ${jobId}\n${stdout}`);
  });

  res.status(202).json({
    success: true,
    data: { message: "Ingestion pipeline triggered successfully in the background.", jobId: jobId },
    error: null,
    metadata: { timestamp, module: "m3", version: "1.0.0" }
  });
});

module.exports = router;