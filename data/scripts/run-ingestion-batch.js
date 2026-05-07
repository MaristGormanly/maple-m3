/**
 * data/scripts/run-ingestion-batch.js — Automated Ingestion Pipeline Runner
 *
 * Runs the MAPLE M3 data ingestion scripts in scheduled batches. Each script
 * is executed as a child process with a 10-minute timeout. Failures are logged
 * and skipped — a single broken script does not halt the rest of the batch.
 *
 * Before each script runs, stale Documents rows are pruned from the database
 * according to the CLEANUP map below. DocumentEmbeddings are removed automatically
 * via ON DELETE CASCADE. news.js is intentionally excluded so historical articles
 * are preserved for lookback queries.
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
 *   daily   — campus-events, news, library, intramurals
 *   weekly  — admin-directory, clubs, health-services, it-helpdesk
 *   monthly — dining-manual, library-services, it-clientTech
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Client } = require('pg');

const SCRIPTS_DIR = path.join(__dirname);
const LOGS_DIR    = path.join(__dirname, '../../logs/ingestion');
const TIMEOUT_MS  = 10 * 60 * 1000; // 10 minutes per script

// Batch definitions — each maps a schedule name to an ordered list of scripts.
// Scripts run sequentially to avoid overwhelming the DB pool or the embedding service.
const BATCHES = {
  daily: [
    'campus-events.js',
    'news.js',
    'library.js',
    'intramurals.js',
  ],
  weekly: [
    'admin-directory.js',
    'clubs.js',
    'health-services.js',
    'it-helpdesk.js',
    'gym-pool.js',
  ],
  monthly: [
    'dining-manual.js',
    'library-services.js',
    'it-clientTech.js',
  ],
};

// Pre-ingestion cleanup rules keyed by script name.
//
// Each entry is an object with:
//   col     — the Documents column to filter on ('source_type' | 'source_title' | 'source_url')
//   val     — the value to match (exact string, or substring for LIKE-based deletes)
//   useLike — (optional) if true, matches rows WHERE col LIKE '%val%' instead of col = val
//   maxAgeDays — (optional) if set, only deletes rows older than this many days
//               (uses last_updated < NOW() - INTERVAL). Omit to delete all matching rows.
//
// Library and IT Support share a source_type between two scripts each, so those
// entries target source_title / source_url to avoid wiping the sibling script's data.
//
// news.js is intentionally absent — historical articles are kept for lookback queries.
const CLEANUP = {
  'campus-events.js':    { col: 'source_type',  val: 'Events',                      maxAgeDays: 7 },
  'library.js':          { col: 'source_title', val: 'Marist Library Hours' },
  'intramurals.js':      { col: 'source_type',  val: 'Recreation' },
  'admin-directory.js':  { col: 'source_type',  val: 'Admin' },
  'clubs.js':            { col: 'source_type',  val: 'Clubs' },
  'health-services.js':  { col: 'source_type',  val: 'Health' },
  'it-helpdesk.js':      { col: 'source_url',   val: 'teamdynamix.marist.edu',       useLike: true },
  'gym-pool.js':         { col: 'source_type',  val: 'RecCenter' },
  'dining-manual.js':    { col: 'source_type',  val: 'Dining' },
  'library-services.js': { col: 'source_title', val: 'Marist Library FAQs' },
  'it-clientTech.js':    { col: 'source_url',   val: 'marist.edu/clienttech',        useLike: true },
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

async function runCleanup(scriptName) {
  const rule = CLEANUP[scriptName];
  if (!rule) return; // no cleanup defined (e.g. news.js)

  const { col, val, useLike = false, maxAgeDays } = rule;

  const client = new Client({
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port:     process.env.DB_PORT,
  });

  try {
    await client.connect();

    const matchExpr = useLike ? `${col} LIKE $1` : `${col} = $1`;
    const matchParam = useLike ? `%${val}%` : val;

    let query, label;
    if (maxAgeDays != null) {
      query = `DELETE FROM Documents WHERE ${matchExpr} AND last_updated < NOW() - INTERVAL '${maxAgeDays} days'`;
      label = `${col} = '${val}', older than ${maxAgeDays}d`;
    } else {
      query = `DELETE FROM Documents WHERE ${matchExpr}`;
      label = `${col} = '${val}'`;
    }

    const res = await client.query(query, [matchParam]);
    writeLog(`CLEAN  ${scriptName} — deleted ${res.rowCount} rows (${label})`);
  } catch (err) {
    // Log but do not abort — the ingestion script will still run
    writeLog(`CLEAN  ${scriptName} — cleanup failed: ${err.message}`);
  } finally {
    await client.end();
  }
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
    await runCleanup(script);
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
