# MAPLE M3 — Ingestion Schedule

All ingestion is driven by `run-ingestion-batch.js`. Run commands from the **repository root**.

## Batch contents

| Batch | Scripts | Frequency | Rationale |
|---|---|---|---|
| `daily` | dining-manual, campus-events, news, library, intramurals | Every day | High-volatility; dining and events change frequently and benefit from daily refresh |
| `weekly` | admin-directory, clubs, health-services, it-helpdesk | Sundays | Moderate-to-low volatility; weekly refresh keeps directories/services current |
| `monthly` | library-services, it-clientTech | First day of each month | Low-volatility support content; monthly refresh is sufficient |

## Manual run

```powershell
# From the repo root
node data/scripts/run-ingestion-batch.js daily
node data/scripts/run-ingestion-batch.js weekly
node data/scripts/run-ingestion-batch.js monthly
```

## Automated schedule — Windows Task Scheduler

Create three scheduled tasks. Open **Task Scheduler** → *Create Basic Task* (or use the PowerShell commands below).

```powershell
# Run from an elevated PowerShell prompt.
# Replace C:\path\to\maple-m3 with the actual repo path.

$repo = "C:\path\to\maple-m3"
$node = (Get-Command node).Source  # resolves to the full node.exe path

# Daily at 5:00 AM — dining-manual, campus-events, news, library, intramurals
schtasks /Create /TN "MAPLE-Ingest-Daily" /TR "`"$node`" `"$repo\data\scripts\run-ingestion-batch.js`" daily" /SC DAILY /ST 05:00 /F

# Sunday at 6:00 AM — admin-directory, clubs, library, library-services, health-services, it-helpdesk, intramurals
schtasks /Create /TN "MAPLE-Ingest-Weekly" /TR "`"$node`" `"$repo\data\scripts\run-ingestion-batch.js`" weekly" /SC WEEKLY /D SUN /ST 06:00 /F

# 1st day of each month at 6:30 AM — it-clientTech
schtasks /Create /TN "MAPLE-Ingest-Monthly" /TR "`"$node`" `"$repo\data\scripts\run-ingestion-batch.js`" monthly" /SC MONTHLY /D 1 /ST 06:30 /F
```

To verify the tasks were created:
```powershell
schtasks /Query /TN "MAPLE-Ingest-Daily"
schtasks /Query /TN "MAPLE-Ingest-Weekly"
schtasks /Query /TN "MAPLE-Ingest-Monthly"
```

To delete a task:
```powershell
schtasks /Delete /TN "MAPLE-Ingest-Daily" /F
```

> **Note:** The scheduled task runs under your Windows user account. Make sure the `.env` file is present in the repo root so scripts can read `DATABASE_URL`, `OPENAI_API_KEY`, etc.

## Automated schedule — macOS (cron)

Use `crontab` with absolute paths. Replace `/Users/you/path/to/maple-m3` with your actual repo path.

```bash
# Resolve your Node path first
which node

# Edit crontab
crontab -e
```

Add entries like:

```cron
# Daily at 5:00 AM — dining-manual, campus-events, news, library, intramurals
0 5 * * * /usr/local/bin/node /Users/you/path/to/maple-m3/data/scripts/run-ingestion-batch.js daily >> /Users/you/path/to/maple-m3/logs/ingestion/cron.log 2>&1

# Weekly (Sunday) at 6:00 AM — admin-directory, clubs, library, library-services, health-services, it-helpdesk, intramurals
0 6 * * 0 /usr/local/bin/node /Users/you/path/to/maple-m3/data/scripts/run-ingestion-batch.js weekly >> /Users/you/path/to/maple-m3/logs/ingestion/cron.log 2>&1

# Monthly on day 1 at 6:30 AM — it-clientTech
30 6 1 * * /usr/local/bin/node /Users/you/path/to/maple-m3/data/scripts/run-ingestion-batch.js monthly >> /Users/you/path/to/maple-m3/logs/ingestion/cron.log 2>&1
```

Useful commands:

```bash
# List current cron entries
crontab -l

# Remove all cron entries (use with caution)
crontab -r
```

## Log files

Each batch run appends to a daily log file at:
```
logs/ingestion/ingestion-YYYY-MM-DD.log
```

The runner exits with code `1` if any script fails, making it easy to spot failures in the Task Scheduler history.
