/**
 * server/src/utils/dataFreshness.js
 *
 * Deterministic staleness evaluator for retrieved RAG chunks.
 * The controller uses this to surface user-facing warnings whenever
 * source data is likely out-of-date.
 */

const MS_PER_HOUR = 1000 * 60 * 60;

const STALE_THRESHOLD_HOURS_BY_SOURCE = {
  Events: 48,
  News: 48,
  Recreation: 48,
  Library: 48,
  Admin: 24 * 10,
  Clubs: 24 * 10,
  Health: 24 * 10,
  'IT Support': 24 * 10,
  default: 24 * 14,
};

const REFERENCE_TITLE_PATTERNS = [
  /faq/i,
  /client tech/i,
  /new student information/i,
  /connect to the network/i,
];

const REFERENCE_CONTENT_STALE_THRESHOLD_HOURS = 24 * 45;

function resolveStaleThresholdHours(chunk) {
  const sourceType = chunk?.source_type || 'default';
  const sourceTitle = chunk?.source_title || '';
  const isReferenceContent = REFERENCE_TITLE_PATTERNS.some((pattern) => pattern.test(sourceTitle));

  if (isReferenceContent) return REFERENCE_CONTENT_STALE_THRESHOLD_HOURS;
  return STALE_THRESHOLD_HOURS_BY_SOURCE[sourceType] || STALE_THRESHOLD_HOURS_BY_SOURCE.default;
}

function evaluateDataFreshness(chunks, now = new Date()) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return {
      status: 'unknown',
      warning: 'I could not determine how recently this data was refreshed. Please verify key details on official Marist pages.',
      oldest_source_age_hours: null,
      stale_sources: [],
    };
  }

  const staleSources = [];
  let hasUnknownTimestamp = false;
  let oldestAgeHours = 0;

  for (const chunk of chunks) {
    const sourceName = chunk?.source_title || chunk?.source_type || 'Unknown source';
    const sourceLastUpdated = chunk?.last_updated;
    const parsed = sourceLastUpdated ? new Date(sourceLastUpdated) : null;

    if (!parsed || Number.isNaN(parsed.getTime())) {
      hasUnknownTimestamp = true;
      continue;
    }

    const ageHours = Math.max(0, (now.getTime() - parsed.getTime()) / MS_PER_HOUR);
    oldestAgeHours = Math.max(oldestAgeHours, ageHours);

    const thresholdHours = resolveStaleThresholdHours(chunk);
    if (ageHours > thresholdHours) {
      staleSources.push({
        title: sourceName,
        source_type: chunk?.source_type || 'Unknown',
        age_hours: Number(ageHours.toFixed(1)),
        stale_after_hours: thresholdHours,
      });
    }
  }

  let status = 'fresh';
  let warning = null;

  if (staleSources.length > 0) {
    status = 'stale';
    warning = 'Some source information may be outdated. Please verify time-sensitive details on official Marist pages.';
  } else if (hasUnknownTimestamp) {
    status = 'unknown';
    warning = 'I could not determine refresh timing for some sources. Please verify key details on official Marist pages.';
  } else {
    const maxThresholdHours = Math.max(...chunks.map(resolveStaleThresholdHours));
    if (oldestAgeHours > maxThresholdHours * 0.75) {
      status = 'aging';
    }
  }

  return {
    status,
    warning,
    oldest_source_age_hours: oldestAgeHours > 0 ? Number(oldestAgeHours.toFixed(1)) : 0,
    stale_sources: staleSources,
  };
}

module.exports = {
  evaluateDataFreshness,
};
