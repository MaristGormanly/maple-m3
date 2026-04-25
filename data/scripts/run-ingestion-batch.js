/**
 * data/scripts/run-ingestion-batch.js — Automated Ingestion Pipeline Runner
 *
 * Runs the MAPLE M3 data ingestion scripts in scheduled batches. Each script
 * is executed as a child process with a 10-minute timeout. Failures are logged
 * and skipped — a single broken script does not halt the rest of the batch.
 *
 * Usage (manual):
 *   node data/scripts/run-ingestion-batch.js               # runs the default "daily" batch
 *   node data/scripts/run-ingestion-batch.js daily         # same as above
 *   node data/scripts/run-ingestion-batch.js weekly        # runs the weekly batch
 *   node data/scripts/run-ingestion-batch.js monthly       # runs the monthly batch
 *
 * Schedule (Windows Task Scheduler — see data/scripts/cron-schedule.md):
 *   Daily at 5:00 AM      →  node data/scripts/run-ingestion-batch.js daily
 *   Sunday at 6:00 AM     →  node data/scripts/run-ingestion-batch.js weekly
 *   1st of month at 6:30 AM → node data/scripts/run-ingestion-batch.js monthly
 *
 * Batches:
 *   daily   — campus-events, news
 *   weekly  — admin-directory, clubs, library, library-services, health-services, it-helpdesk, intramurals
 *   monthly — it-clientTech
 *
 * Scripts excluded from automation (add once stable/ready):
 *   gym-pool.js     — script not yet stable; to be added after team fixes
 *   dining-hours.js — hardcoded fallback in server/src/utils/dining.js (Cloudflare blocks scraping)
 *   dining-menus.js — same reason; redirect to live site provided instead
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPTS_DIR = path.join(__dirname);
const LOGS_DIR    = path.join(__dirname, '../../logs/ingestion');
const TIMEOUT_MS  = 10 * 60 * 1000; // 10 minutes per script

// Batch definitions — each maps a schedule name to an ordered list of scripts.
// Scripts run sequentially to avoid overwhelming the DB pool or the embedding service.
const BATCHES = {
  daily: [
    'campus-events.js',
    'news.js',
  ],
  weekly: [
    'admin-directory.js',
    'clubs.js',
    'library.js',
    'library-services.js',
    'health-services.js',
    'it-helpdesk.js',
    'intramurals.js',
  ],
  monthly: [
    'it-clientTech.js',
  ],
};

// Ensure the ingestion logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getLogPath() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOGS_DIR, `ingestion-${date}.log`);
}

function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  fs.appendFileSync(getLogPath(), line);
}

function runScript(scriptName) {
  return new Promise((resolve) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    const start = Date.now();

    writeLog(`START  ${scriptName}`);

    const child = execFile('node', [scriptPath], { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      if (stdout) {
        stdout.trim().split('\n').forEach(line => writeLog(`  [${scriptName}] ${line}`));
      }
      if (stderr) {
        stderr.trim().split('\n').forEach(line => writeLog(`  [${scriptName}][stderr] ${line}`));
      }

      if (error) {
        const reason = error.killed ? `TIMEOUT after ${TIMEOUT_MS / 1000}s` : error.message;
        writeLog(`FAIL   ${scriptName} — ${reason} (${elapsed}s)`);
        resolve({ script: scriptName, success: false, reason, elapsed });
      } else {
        writeLog(`OK     ${scriptName} (${elapsed}s)`);
        resolve({ script: scriptName, success: true, elapsed });
      }
    });

    // Ensure the child is killed on timeout
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, TIMEOUT_MS);
  });
}

async function runBatch(batchName) {
  const scripts = BATCHES[batchName];
  if (!scripts) {
    writeLog(`ERROR  Unknown batch name "${batchName}". Valid options: ${Object.keys(BATCHES).join(', ')}`);
    process.exit(1);
  }

  writeLog(`=== MAPLE M3 Ingestion Batch: "${batchName}" (${scripts.length} scripts) ===`);

  const results = [];
  for (const script of scripts) {
    const result = await runScript(script);
    results.push(result);
  }

  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success);

  writeLog(`=== Batch complete: ${passed}/${results.length} succeeded ===`);

  if (failed.length > 0) {
    writeLog(`Failed scripts:`);
    failed.forEach(r => writeLog(`  ✗ ${r.script} — ${r.reason}`));
    // Exit non-zero so cron/monitoring can detect failures
    process.exit(1);
  } else {
    process.exit(0);
  }
}

const batchName = process.argv[2] || 'daily';
runBatch(batchName);
