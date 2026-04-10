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
  try {
    const db = retrievalService.getDbClient();
    const result = await db.query(`
      SELECT title, location, start_time, category 
      FROM CampusEvents 
      WHERE start_time >= NOW() 
      ORDER BY start_time ASC 
      LIMIT 10;
    `);

    res.status(200).json({
      success: true,
      data: result.rows,
      error: null,
      metadata: { timestamp: new Date().toISOString(), module: "m3", version: "1.0.0" }
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: { code: 'DB_ERROR', message: err.message }});
  }
});

// Trigger actual data ingestion pipeline script
router.post('/ingest', (req, res) => {
  const { source_type } = req.body;
  
  if (source_type !== 'Admin') {
    return res.status(400).json({ success: false, data: null, error: { message: "Only 'Admin' source ingestion is supported via API for MVP." }});
  }

  // Trigger the script asynchronously
  const scriptPath = path.join(__dirname, '../../../data/scripts/admin-directory.js');
  exec(`node ${scriptPath}`, (error, stdout, stderr) => {
    if (error) console.error(`Ingest Error: ${error.message}`);
    if (stderr) console.error(`Ingest Stderr: ${stderr}`);
    console.log(`Ingest Output: ${stdout}`);
  });

  res.status(202).json({
    success: true,
    data: { message: "Ingestion pipeline triggered successfully in the background.", jobId: `job_${Date.now()}` },
    error: null,
    metadata: { timestamp: new Date().toISOString(), module: "m3", version: "1.0.0" }
  });
});

module.exports = router;