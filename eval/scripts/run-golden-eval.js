/**
 * MAPLE M3 Golden Evaluation Runner
 *
 * Implements design-doc aligned evaluation dimensions:
 * - Functional categories: core, temporal, routing, adversarial
 * - Retrieval quality: precision + recall (hint-based approximation)
 * - Answer quality: faithfulness + relevance
 * - Observability: required log-field schema compliance
 *
 * Usage:
 *   node eval/scripts/run-golden-eval.js
 *   BASE_URL=http://localhost:3000 node eval/scripts/run-golden-eval.js
 *   EVAL_JUDGE_MODE=llm EVAL_JUDGE_MODEL=gpt-4o-mini OPENAI_API_KEY=... node eval/scripts/run-golden-eval.js
 */

const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

const ROOT = path.join(__dirname, '../..');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DATASET_PATH = process.env.GOLDEN_DATASET_PATH || path.join(ROOT, 'eval/test-cases/golden-dataset.json');
const RESULTS_DIR = path.join(ROOT, 'eval/results');
const LOGS_DIR = path.join(ROOT, 'logs');
const JUDGE_MODE = process.env.EVAL_JUDGE_MODE || 'heuristic'; // heuristic | llm
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'gpt-4o-mini';

function normalize(value) {
  return String(value || '').toLowerCase();
}

function nowStamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function includesAny(text, options) {
  return (options || []).some((opt) => normalize(text).includes(normalize(opt)));
}

function includesNone(text, options) {
  return (options || []).every((opt) => !normalize(text).includes(normalize(opt)));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sourceBlob(sources) {
  return (sources || []).map((s) => `${s.title || ''} ${s.url || ''}`).join(' ').toLowerCase();
}

function getTodayLogPath() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOGS_DIR, `maple-m3-${date}.log`);
}

function parseNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch (_) {
      // ignore malformed log lines
    }
  }
  return parsed;
}

function checkRequiredFields(event, requiredFields) {
  return requiredFields.filter((field) => event[field] === undefined);
}

function evaluateRetrievalQuality(expected, body) {
  const hintsRelevant = expected.relevant_source_hints || [];
  const hintsIrrelevant = expected.irrelevant_source_hints || [];
  const sources = body?.data?.sources || [];
  const blob = sourceBlob(sources);
  const model = normalize(body?.metadata?.model);
  const allowHardcoded = Boolean(expected.allow_hardcoded_model);
  const hardcodedBypass = allowHardcoded && model === 'hardcoded';

  if (sources.length === 0 && hardcodedBypass) {
    return {
      precision: 1,
      recall: 1,
      notes: ['hardcoded_fallback_bypass']
    };
  }

  if (hintsRelevant.length === 0) {
    return {
      precision: 1,
      recall: 1,
      notes: ['no_retrieval_hints']
    };
  }

  const relevantHitCount = hintsRelevant.filter((hint) => blob.includes(normalize(hint))).length;
  const irrelevantHitCount = hintsIrrelevant.filter((hint) => blob.includes(normalize(hint))).length;

  const recall = hintsRelevant.length > 0 ? relevantHitCount / hintsRelevant.length : 1;
  const precisionDenom = relevantHitCount + irrelevantHitCount;
  const precision = precisionDenom > 0 ? relevantHitCount / precisionDenom : (relevantHitCount > 0 ? 1 : 0);

  return {
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    notes: []
  };
}

async function judgeWithLlm(openai, testCase, body) {
  const responseText = body?.data?.response || '';
  const sources = body?.data?.sources || [];
  const freshness = body?.data?.freshness || null;
  const prompt = `
You are grading a campus-assistant answer. Return strict JSON only.

Query:
${testCase.query}

Model Answer:
${responseText}

Sources:
${JSON.stringify(sources, null, 2)}

Freshness:
${JSON.stringify(freshness, null, 2)}

Grade:
1) faithfulness_pass: true if answer is supported by provided sources or clearly uncertainty-safe.
2) relevance_pass: true if answer directly addresses the query and avoids unnecessary unrelated content.
3) reasons: short array of reasons.

Output JSON shape:
{"faithfulness_pass":true,"relevance_pass":true,"reasons":["..."]}
`;

  const completion = await openai.responses.create({
    model: JUDGE_MODEL,
    input: prompt,
    temperature: 0
  });
  const text = completion.output_text || '{}';
  try {
    return JSON.parse(text);
  } catch (_) {
    return {
      faithfulness_pass: false,
      relevance_pass: false,
      reasons: ['judge_parse_failure']
    };
  }
}

function judgeHeuristic(testCase, body) {
  const responseText = normalize(body?.data?.response);
  const errorText = normalize(`${body?.error?.code || ''} ${body?.error?.message || ''}`);
  const sources = body?.data?.sources || [];
  const expected = testCase.expected || {};
  const reasons = [];

  let faithfulnessPass = true;
  let relevancePass = true;

  const hasSources = Array.isArray(sources) && sources.length > 0;
  const hardcoded = normalize(body?.metadata?.model) === 'hardcoded';
  const allowHardcoded = Boolean(expected.allow_hardcoded_model);
  const retrievalFailedSafePath = expected.requires_refusal_or_safe_behavior && body?.error?.code === 'RETRIEVAL_FAILED';

  if (!retrievalFailedSafePath && !hasSources && !(hardcoded && allowHardcoded)) {
    faithfulnessPass = false;
    reasons.push('no_sources_for_faithfulness');
  }

  if (!retrievalFailedSafePath && responseText.length < 10) {
    relevancePass = false;
    reasons.push('response_too_short');
  }

  if (Array.isArray(expected.must_include_any) && expected.must_include_any.length > 0) {
    if (!includesAny(responseText, expected.must_include_any)) {
      relevancePass = false;
      reasons.push('missing_expected_topics');
    }
  }

  if (Array.isArray(expected.must_not_include_any) && expected.must_not_include_any.length > 0) {
    if (!includesNone(responseText, expected.must_not_include_any)) {
      faithfulnessPass = false;
      reasons.push('contains_forbidden_content');
    }
  }

  if (expected.requires_refusal_or_safe_behavior) {
    const safeIndicators = ['sorry', 'cannot', "can't", 'unable', 'module', 'm1', 'm2', 'contact'];
    const safeInResponse = includesAny(responseText, safeIndicators);
    const safeInError = includesAny(errorText, ['retrieval_failed', ...safeIndicators]);
    if (!safeInResponse && !safeInError && !retrievalFailedSafePath) {
      relevancePass = false;
      reasons.push('missing_safe_refusal_behavior');
    }
  }

  return {
    faithfulness_pass: faithfulnessPass,
    relevance_pass: relevancePass,
    reasons
  };
}

function evaluateContract(testCase, status, body) {
  const expected = testCase.expected || {};
  const reasons = [];
  const responseText = normalize(body?.data?.response);
  const sources = body?.data?.sources || [];
  const sourceText = sourceBlob(sources);
  const model = normalize(body?.metadata?.model);

  if (typeof expected.status === 'number' && status !== expected.status) {
    reasons.push(`status_expected_${expected.status}_got_${status}`);
  }
  if (Array.isArray(expected.status_any) && expected.status_any.length > 0) {
    if (!expected.status_any.includes(status)) {
      reasons.push(`status_not_in_allowed_set:${expected.status_any.join('|')},got_${status}`);
    }
  }

  if (expected.must_have_sources && !Array.isArray(sources)) {
    reasons.push('missing_sources_array');
  }

  if (Array.isArray(expected.must_include_any) && expected.must_include_any.length > 0) {
    if (!includesAny(responseText, expected.must_include_any)) {
      reasons.push(`missing_any_required_text:${expected.must_include_any.join('|')}`);
    }
  }

  if (Array.isArray(expected.must_not_include_any) && expected.must_not_include_any.length > 0) {
    if (!includesNone(responseText, expected.must_not_include_any)) {
      reasons.push(`contains_forbidden_text:${expected.must_not_include_any.join('|')}`);
    }
  }

  if (Array.isArray(expected.source_title_or_url_any) && expected.source_title_or_url_any.length > 0) {
    const allowHardcoded = Boolean(expected.allow_hardcoded_model);
    const hardcodedBypass = allowHardcoded && model === 'hardcoded';
    if (!hardcodedBypass && !includesAny(sourceText, expected.source_title_or_url_any)) {
      reasons.push(`source_routing_miss:${expected.source_title_or_url_any.join('|')}`);
    }
  }

  if (expected.requires_freshness_field) {
    const freshness = body?.data?.freshness;
    if (!freshness || !['fresh', 'aging', 'stale', 'unknown'].includes(freshness.status)) {
      reasons.push('missing_or_invalid_freshness');
    }
  }

  return {
    pass: reasons.length === 0,
    reasons
  };
}

function summarizeByCategory(rows) {
  const out = {};
  for (const row of rows) {
    if (!out[row.category]) {
      out[row.category] = { total: 0, passed: 0, failed: 0 };
    }
    out[row.category].total += 1;
    if (row.pass) out[row.category].passed += 1;
    else out[row.category].failed += 1;
  }
  return out;
}

function percentage(part, whole) {
  if (!whole) return 0;
  return Number(((part / whole) * 100).toFixed(1));
}

function evaluateThresholds(datasetThresholds, metrics) {
  const checks = [];
  const t = datasetThresholds || {};
  if (t.overall_pass_rate_percent !== undefined) {
    checks.push({
      metric: 'overall_pass_rate_percent',
      expected_min: t.overall_pass_rate_percent,
      actual: metrics.overall_pass_rate_percent,
      pass: metrics.overall_pass_rate_percent >= t.overall_pass_rate_percent
    });
  }
  if (t.retrieval_precision_percent !== undefined) {
    checks.push({
      metric: 'retrieval_precision_percent',
      expected_min: t.retrieval_precision_percent,
      actual: metrics.retrieval_precision_percent,
      pass: metrics.retrieval_precision_percent >= t.retrieval_precision_percent
    });
  }
  if (t.retrieval_recall_percent !== undefined) {
    checks.push({
      metric: 'retrieval_recall_percent',
      expected_min: t.retrieval_recall_percent,
      actual: metrics.retrieval_recall_percent,
      pass: metrics.retrieval_recall_percent >= t.retrieval_recall_percent
    });
  }
  if (t.faithfulness_pass_rate_percent !== undefined) {
    checks.push({
      metric: 'faithfulness_pass_rate_percent',
      expected_min: t.faithfulness_pass_rate_percent,
      actual: metrics.faithfulness_pass_rate_percent,
      pass: metrics.faithfulness_pass_rate_percent >= t.faithfulness_pass_rate_percent
    });
  }
  if (t.relevance_pass_rate_percent !== undefined) {
    checks.push({
      metric: 'relevance_pass_rate_percent',
      expected_min: t.relevance_pass_rate_percent,
      actual: metrics.relevance_pass_rate_percent,
      pass: metrics.relevance_pass_rate_percent >= t.relevance_pass_rate_percent
    });
  }
  if (t.log_schema_compliance_percent !== undefined) {
    checks.push({
      metric: 'log_schema_compliance_percent',
      expected_min: t.log_schema_compliance_percent,
      actual: metrics.log_schema_compliance_percent,
      pass: metrics.log_schema_compliance_percent >= t.log_schema_compliance_percent
    });
  }
  return checks;
}

async function run() {
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  const cases = dataset.cases || [];
  ensureDir(RESULTS_DIR);
  const startedAt = new Date();

  let judgeClient = null;
  if (JUDGE_MODE === 'llm') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('EVAL_JUDGE_MODE=llm requires OPENAI_API_KEY');
    }
    judgeClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  console.log(`\nRunning MAPLE golden evaluation`);
  console.log(`- Base URL: ${BASE_URL}`);
  console.log(`- Dataset: ${DATASET_PATH}`);
  console.log(`- Judge mode: ${JUDGE_MODE}${JUDGE_MODE === 'llm' ? ` (${JUDGE_MODEL})` : ''}`);
  console.log(`- Cases: ${cases.length}\n`);

  const caseRows = [];
  for (const testCase of cases) {
    const startedMs = Date.now();
    let status = null;
    let body = null;
    let transportError = null;

    try {
      const response = await fetch(`${BASE_URL}/api/v1/campus/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: testCase.query })
      });
      status = response.status;
      body = await response.json().catch(() => ({}));
    } catch (err) {
      transportError = err?.message || 'unknown_transport_error';
    }

    let contract = { pass: false, reasons: [] };
    let retrieval = { precision: 0, recall: 0, notes: [] };
    let quality = { faithfulness_pass: false, relevance_pass: false, reasons: [] };
    let pass = false;
    const reasons = [];

    if (transportError) {
      reasons.push(`transport_error:${transportError}`);
    } else {
      contract = evaluateContract(testCase, status, body);
      retrieval = evaluateRetrievalQuality(testCase.expected || {}, body);
      quality = JUDGE_MODE === 'llm'
        ? await judgeWithLlm(judgeClient, testCase, body)
        : judgeHeuristic(testCase, body);

      if (!contract.pass) reasons.push(...contract.reasons);
      if (!quality.faithfulness_pass) reasons.push('faithfulness_fail');
      if (!quality.relevance_pass) reasons.push('relevance_fail');
      if (Array.isArray(quality.reasons) && quality.reasons.length > 0) reasons.push(...quality.reasons);
    }

    pass = reasons.length === 0;

    caseRows.push({
      id: testCase.id,
      category: testCase.category,
      query: testCase.query,
      status,
      pass,
      reasons,
      elapsed_ms: Date.now() - startedMs,
      model: body?.metadata?.model || null,
      contract_pass: contract.pass,
      contract_reasons: contract.reasons,
      retrieval_precision: retrieval.precision,
      retrieval_recall: retrieval.recall,
      faithfulness_pass: Boolean(quality.faithfulness_pass),
      relevance_pass: Boolean(quality.relevance_pass),
      judge_mode: JUDGE_MODE
    });

    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${testCase.id} (${testCase.category})${pass ? '' : ` — ${reasons.join(', ')}`}`);
  }

  const total = caseRows.length;
  const passed = caseRows.filter((r) => r.pass).length;
  const failed = total - passed;

  const avgPrecision = caseRows.reduce((sum, r) => sum + (r.retrieval_precision || 0), 0) / Math.max(1, total);
  const avgRecall = caseRows.reduce((sum, r) => sum + (r.retrieval_recall || 0), 0) / Math.max(1, total);
  const faithfulnessPassed = caseRows.filter((r) => r.faithfulness_pass).length;
  const relevancePassed = caseRows.filter((r) => r.relevance_pass).length;

  const logFile = getTodayLogPath();
  const allLogEvents = parseNdjson(logFile);
  const runEvents = allLogEvents.filter((event) => {
    const ts = new Date(event.timestamp || 0).getTime();
    return Number.isFinite(ts) && ts >= startedAt.getTime();
  });

  const llmEvents = runEvents.filter((e) => e.event_type === 'llm_call');
  const retrievalEvents = runEvents.filter((e) => e.event_type === 'retrieval');

  const llmRequired = ['timestamp', 'module', 'event_type', 'model', 'input_tokens', 'output_tokens', 'latency_ms', 'success'];
  const retrievalRequired = ['timestamp', 'module', 'event_type', 'query', 'chunks_retrieved', 'top_score', 'min_score', 'threshold_applied'];

  const logViolations = [];
  llmEvents.forEach((event, idx) => {
    const missing = checkRequiredFields(event, llmRequired);
    if (missing.length > 0) logViolations.push({ event_type: 'llm_call', index: idx, missing });
  });
  retrievalEvents.forEach((event, idx) => {
    const missing = checkRequiredFields(event, retrievalRequired);
    if (missing.length > 0) logViolations.push({ event_type: 'retrieval', index: idx, missing });
  });

  const totalCheckedEvents = llmEvents.length + retrievalEvents.length;
  const compliantEvents = Math.max(0, totalCheckedEvents - logViolations.length);
  const logCompliance = totalCheckedEvents > 0 ? percentage(compliantEvents, totalCheckedEvents) : 0;

  const metrics = {
    overall_pass_rate_percent: percentage(passed, total),
    retrieval_precision_percent: Number((avgPrecision * 100).toFixed(1)),
    retrieval_recall_percent: Number((avgRecall * 100).toFixed(1)),
    faithfulness_pass_rate_percent: percentage(faithfulnessPassed, total),
    relevance_pass_rate_percent: percentage(relevancePassed, total),
    log_schema_compliance_percent: logCompliance
  };

  const thresholdChecks = evaluateThresholds(dataset.thresholds || {}, metrics);
  const overallThresholdPass = thresholdChecks.every((c) => c.pass);

  const report = {
    dataset_version: dataset.version || 'unknown',
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    base_url: BASE_URL,
    judge_mode: JUDGE_MODE,
    judge_model: JUDGE_MODE === 'llm' ? JUDGE_MODEL : null,
    totals: {
      total,
      passed,
      failed
    },
    categories: summarizeByCategory(caseRows),
    metrics,
    thresholds: {
      expected: dataset.thresholds || {},
      checks: thresholdChecks,
      pass: overallThresholdPass
    },
    observability: {
      log_file: logFile,
      events_checked: totalCheckedEvents,
      llm_events_checked: llmEvents.length,
      retrieval_events_checked: retrievalEvents.length,
      violations: logViolations
    },
    results: caseRows
  };

  const outPath = path.join(RESULTS_DIR, `golden-eval-${nowStamp()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n=== Golden Evaluation Summary ===');
  console.log(`Passed: ${passed}/${total} (${metrics.overall_pass_rate_percent}%)`);
  console.log(`Retrieval precision: ${metrics.retrieval_precision_percent}%`);
  console.log(`Retrieval recall: ${metrics.retrieval_recall_percent}%`);
  console.log(`Faithfulness pass: ${metrics.faithfulness_pass_rate_percent}%`);
  console.log(`Relevance pass: ${metrics.relevance_pass_rate_percent}%`);
  console.log(`Log schema compliance: ${metrics.log_schema_compliance_percent}%`);
  console.log(`Thresholds pass: ${overallThresholdPass ? 'YES' : 'NO'}`);
  console.log(`Results: ${outPath}\n`);

  if (!overallThresholdPass || failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Golden evaluation failed:', err);
  process.exit(1);
});
