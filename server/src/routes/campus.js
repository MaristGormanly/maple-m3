const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const path = require('path');
const { handleChat } = require('../controllers/chat');
const { apiLimiter } = require('../middleware/security');
const retrievalService = require('../services/retrieval');

router.post('/chat', apiLimiter, handleChat);

// Fetch actual upcoming events from the database
router.get('/status', async (req, res) => {
  const timestamp = new Date().toISOString();
  try {
    const { date } = req.query; // e.g., ?date=2026-04-15
    const pool = retrievalService.getDbPool();
    
    let queryText = '';
    let queryParams = [];

    // Support ?date= filtering per Design Doc
    if (date) {
      queryText = `
        SELECT title, location, start_time, category 
        FROM CampusEvents 
        WHERE DATE(start_time) = $1::date
        ORDER BY start_time ASC;
      `;
      queryParams.push(date);
    } else {
      queryText = `
        SELECT title, location, start_time, category 
        FROM CampusEvents 
        WHERE start_time >= NOW() 
        ORDER BY start_time ASC 
        LIMIT 10;
      `;
    }

    const result = await pool.query(queryText, queryParams);

    res.status(200).json({
      success: true,
      data: result.rows,
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

// Trigger actual data ingestion pipeline script
router.post('/ingest', (req, res) => {
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