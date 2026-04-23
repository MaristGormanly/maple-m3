# MAPLE M3 — Ingestion Schedule

All ingestion is driven by `run-ingestion-batch.js`. Run commands from the **repository root**.

## Batch contents

| Batch | Scripts | Frequency | Rationale |
|---|---|---|---|
| `daily` | campus-events, news | Every day | High-volatility; events and news change daily |
| `midweek` | admin-directory, clubs | Mon/Wed/Fri | Moderate change; keeps office/club info fresh without hammering the directory |
| `weekly` | library, library-services, health-services, it-helpdesk, intramurals | Sundays | Low-volatility; semester-level changes; one refresh per week is sufficient |

## Manual run

```powershell
# From the repo root
node data/scripts/run-ingestion-batch.js daily
node data/scripts/run-ingestion-batch.js midweek
node data/scripts/run-ingestion-batch.js weekly
```

## Automated schedule — Windows Task Scheduler

Create three scheduled tasks. Open **Task Scheduler** → *Create Basic Task* (or use the PowerShell commands below).

```powershell
# Run from an elevated PowerShell prompt.
# Replace C:\path\to\maple-m3 with the actual repo path.

$repo = "C:\path\to\maple-m3"
$node = (Get-Command node).Source  # resolves to the full node.exe path

# Daily at 5:00 AM — campus-events, news
schtasks /Create /TN "MAPLE-Ingest-Daily" /TR "`"$node`" `"$repo\data\scripts\run-ingestion-batch.js`" daily" /SC DAILY /ST 05:00 /F

# Mon/Wed/Fri at 5:30 AM — admin-directory, clubs
schtasks /Create /TN "MAPLE-Ingest-Midweek" /TR "`"$node`" `"$repo\data\scripts\run-ingestion-batch.js`" midweek" /SC WEEKLY /D MON,WED,FRI /ST 05:30 /F

# Sunday at 6:00 AM — library, library-services, health-services, it-helpdesk, intramurals
schtasks /Create /TN "MAPLE-Ingest-Weekly" /TR "`"$node`" `"$repo\data\scripts\run-ingestion-batch.js`" weekly" /SC WEEKLY /D SUN /ST 06:00 /F
```

To verify the tasks were created:
```powershell
schtasks /Query /TN "MAPLE-Ingest-Daily"
schtasks /Query /TN "MAPLE-Ingest-Midweek"
schtasks /Query /TN "MAPLE-Ingest-Weekly"
```

To delete a task:
```powershell
schtasks /Delete /TN "MAPLE-Ingest-Daily" /F
```

> **Note:** The scheduled task runs under your Windows user account. Make sure the `.env` file is present in the repo root so scripts can read `DATABASE_URL`, `OPENAI_API_KEY`, etc.

## Log files

Each batch run appends to a daily log file at:
```
logs/ingestion/ingestion-YYYY-MM-DD.log
```

The runner exits with code `1` if any script fails, making it easy to spot failures in the Task Scheduler history.
