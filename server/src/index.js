const express = require('express');
const cors = require('cors');
const path = require('path');
const { Client } = require('pg');

// Load environment variables from the root .env file
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Required by security baseline
app.use(express.json()); // Parses incoming JSON payloads

// Initialize PostgreSQL Client to ensure DB is reachable
const dbClient = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Basic Health Check Route
app.get('/health', async (req, res) => {
  try {
    res.status(200).json({ 
      status: 'healthy', 
      message: 'MAPLE M3 Campus Services API is running.' 
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Start the Server
async function startServer() {
  try {
    await dbClient.connect();
    console.log('Connected to MAPLE M3 PostgreSQL Database');
    
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server or connect to database:', error);
    process.exit(1);
  }
}

startServer();