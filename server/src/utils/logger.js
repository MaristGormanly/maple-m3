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