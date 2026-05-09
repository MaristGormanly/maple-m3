const DINING_HOURS_TEXT = [
  'Typical semester dining hours:',
  '- Murray Student Center Dining Hall: Mon-Fri 7:00 AM-9:00 PM; Sat-Sun 9:00 AM-8:00 PM',
  '- North End (Yella\'s / Halal Shack / York Street / Chef Jet): generally open late morning through evening on weekdays',
  '- Saxbys (Dyson): weekday daytime hours with reduced weekend hours',
  '',
  'Dining hours can change for holidays, breaks, and special events.',
  'For the latest live hours and menus, use: https://dineoncampus.com/marist'
].join('\n');

const DINING_KEYWORDS = [
  'dining',
  'cafeteria',
  'food',
  'meal',
  'menu',
  'breakfast',
  'lunch',
  'dinner',
  'halal shack',
  'saxbys',
  'yella',
  'york street',
  'chef jet',
  'murray'
];

function isDiningQuery(message) {
  if (!message || typeof message !== 'string') return false;
  const normalized = message.toLowerCase();

  if (DINING_KEYWORDS.some((keyword) => normalized.includes(keyword))) return true;
  if (/\b(open|hours|close|closing)\b/.test(normalized) && /\b(food|dining|cafeteria|eat)\b/.test(normalized)) return true;

  return false;
}

function buildDiningResponse() {
  return {
    response: DINING_HOURS_TEXT,
    sources: [
      {
        title: 'Marist Dining - Live Hours and Menus',
        url: 'https://dineoncampus.com/marist'
      }
    ],
    confidence: 'high',
    freshness: {
      status: 'unknown',
      warning: 'Dining schedules can change due to holidays or special campus events. Check the live dining site for the most current hours.',
      oldest_source_age_hours: null,
      stale_sources: []
    }
  };
}

module.exports = { isDiningQuery, buildDiningResponse };
