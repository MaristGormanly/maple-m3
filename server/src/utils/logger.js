/**
 * server/src/utils/logger.js — Structured JSON Logger
 *
 * Provides lightweight structured logging for all AI interactions, satisfying the
 * MAPLE Architecture Guide observability requirement. Logs are written as newline-
 * delimited JSON to daily rotating files in logs/maple-m3-YYYY-MM-DD.log.
 * The logs/ directory is created automatically if it does not exist.
 *
 * Exported functions (each writes one JSON event line):
 *  logLLMCall(data)   — records an LLM generation attempt with model, token usage,
 *                        latency, estimated cost, success flag, and error if any
 *  logRetrieval(data) — records a vector search with query, chunks retrieved,
 *                        top/min similarity scores, and the threshold applied
 *  logError(data)     — records an unexpected error with source and message
 *
 * All events include timestamp and module: "m3" fields automatically.
 * These log files are the primary observability output for the MAPLE pilot evaluation.
 */
const fs = require('fs');
const path = require('path');

// Ensure log directory exists
const logDir = path.join(__dirname, '../../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const getLogFileName = () => {
  const date = new Date().toISOString().split('T')[0];
  return path.join(logDir, `maple-m3-${date}.log`);
};

const writeLog = (eventData) => {
  const logEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    module: "m3",
    ...eventData
  }) + '\n';
  
  fs.appendFile(getLogFileName(), logEntry, (err) => {
    if (err) console.error('[Logger Error]: Failed to write log', err);
  });
};

module.exports = {
  logLLMCall: (data) => writeLog({ event_type: "llm_call", ...data }),
  logRetrieval: (data) => writeLog({ event_type: "retrieval", ...data }),
  logError: (data) => writeLog({ event_type: "error", ...data })
};