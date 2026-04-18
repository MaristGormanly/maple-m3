/**
 * server/src/middleware/security.js — Security Middleware
 *
 * Exports two Express middleware instances that satisfy the MAPLE Architecture Guide
 * security baseline requirements:
 *
 *  apiLimiter  — express-rate-limit instance applied to AI-powered endpoints (/chat).
 *                Caps each IP at 30 requests per minute to prevent accidental cost spikes
 *                and abuse. Returns a MAPLE-compliant RATE_LIMITED (429) error envelope
 *                on violation.
 *
 *  corsMiddleware — cors instance configured to allow only trusted origins. The allowed
 *                   origins list is driven by the ALLOWED_ORIGINS environment variable
 *                   (comma-separated) so it can differ between local development
 *                   (http://localhost:4200) and production without a code change.
 *                   Requests with no Origin header (e.g. curl, mobile) are also permitted.
 */
const rateLimit = require('express-rate-limit');
const cors = require('cors');

// Rate limiting: 30 requests per IP per minute
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 30,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      data: null,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      metadata: { timestamp: new Date().toISOString(), module: "m3", version: "1.0.0" }
    });
  }
});

// CORS configuration - Environment Driven
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:4200'];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  optionsSuccessStatus: 200
};

const corsMiddleware = cors(corsOptions);
module.exports = { apiLimiter, corsMiddleware };