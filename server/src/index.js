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
    const db = retrievalService.getDbClient();
    await db.query('SELECT 1'); 
    res.status(200).json({ status: 'healthy', message: 'MAPLE M3 API is running.' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'DB connection failed.' });
  }
});

app.use('/api/v1/campus', campusRoutes);

async function startServer() {
  try {
    // Fix: Await DB readiness before opening the port
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