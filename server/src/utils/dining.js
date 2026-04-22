/**
 * server/src/utils/dining.js — Hardcoded Dining Hours & Menu Links
 *
 * Provides static dining hours and menu link responses for the MAPLE M3 chat
 * pipeline. Marist dining data is hosted on dineoncampus.com which is protected
 * by Cloudflare, making automated scraping unreliable. This module intercepts
 * dining-related queries in the chat controller and returns hardcoded typical
 * semester hours plus official live links, bypassing the RAG pipeline entirely.
 *
 * Hours are sourced from dineoncampus.com/marist and reflect typical semester
 * operating hours. Students are always directed to the live site to confirm,
 * since hours may vary on holidays or special events.
 *
 * Exports:
 *  isDiningQuery(lowerMessage)    — true if the lowercased message relates to dining
 *  getDiningResponse(lowerMessage) — markdown-formatted response string
 *  DINING_SOURCES                 — sources array for the MAPLE response envelope
 */

const DINING_HOURS_URL = 'https://dineoncampus.com/marist/hours-of-operation';
const DINING_MENU_URL  = 'https://dineoncampus.com/marist/whats-on-the-menu';

// Each location entry has a display name, building, keyword triggers, and
// typical semester hours broken into day-range rows.
const LOCATIONS = [
  {
    name: 'Murray Dining Hall',
    building: 'Murray Student Center',
    keywords: ['murray dining', 'murray dining hall', 'murray hall'],
    hours: [
      { days: 'Mon – Thu', hours: '7:00am – 8:30pm' },
      { days: 'Fri',       hours: '7:00am – 8:00pm' },
      { days: 'Sat – Sun', hours: '8:00am – 8:00pm' },
    ],
  },
  {
    name: 'Cabaret',
    building: 'Murray Student Center',
    keywords: ['cabaret'],
    hours: [
      { days: 'Daily', hours: '4:00pm – 12:00am' },
    ],
  },
  {
    name: 'Chef Jet',
    building: 'North End Dining',
    keywords: ['chef jet'],
    hours: [
      { days: 'Mon – Thu', hours: '4:00pm – 9:00pm' },
      { days: 'Fri',       hours: '12:00pm – 8:00pm' },
      { days: 'Sat – Sun', hours: 'Closed' },
    ],
  },
  {
    name: 'Halal Shack',
    building: 'North End Dining',
    keywords: ['halal shack', 'halal'],
    hours: [
      { days: 'Mon – Thu', hours: '11:00am – 10:00pm' },
      { days: 'Fri',       hours: '11:00am – 8:00pm' },
      { days: 'Sat – Sun', hours: 'Closed' },
    ],
  },
  {
    name: "Yella's",
    building: 'North End Dining',
    keywords: ["yella's", 'yellas', 'yella'],
    hours: [
      { days: 'Mon – Thu', hours: '11:00am – 11:00pm' },
      { days: 'Fri',       hours: '11:00am – 8:00pm' },
      { days: 'Sat – Sun', hours: '11:00am – 8:00pm' },
    ],
  },
  {
    name: 'York Street',
    building: 'North End Dining',
    keywords: ['york street'],
    hours: [
      { days: 'Mon – Thu', hours: '8:00am – 8:00pm' },
      { days: 'Fri',       hours: '8:00am – 7:00pm' },
      { days: 'Sat – Sun', hours: 'Closed' },
    ],
  },
  {
    name: 'Saxbys',
    building: 'The Dyson Center',
    keywords: ['saxbys', 'dyson center', 'dyson'],
    hours: [
      { days: 'Mon – Thu', hours: '7:00am – 7:00pm' },
      { days: 'Fri',       hours: '8:00am – 4:00pm' },
      { days: 'Sat',       hours: '10:00am – 3:00pm' },
      { days: 'Sun',       hours: '10:00am – 2:00pm' },
    ],
  },
  {
    name: 'Marketplace',
    building: 'Upper West Cedar',
    keywords: ['marketplace', 'upper west cedar', 'upper west'],
    hours: [
      { days: 'Mon – Fri', hours: '10:00am – 10:00pm' },
      { days: 'Sat – Sun', hours: '11:00am – 9:00pm' },
    ],
  },
  {
    name: 'Books & Beans',
    building: 'James A. Cannavino Library',
    keywords: ['books & beans', 'books and beans', 'books beans'],
    hours: [
      { days: 'Mon – Fri', hours: '7:00am – 3:00pm' },
      { days: 'Sat – Sun', hours: 'Closed' },
    ],
  },
  {
    name: 'Steel Plant Cafe',
    building: 'The Steel Plant',
    keywords: ['steel plant cafe', 'steel plant'],
    hours: [
      { days: 'Mon – Fri', hours: '7:30am – 4:00pm' },
      { days: 'Sat – Sun', hours: 'Closed' },
    ],
  },
  {
    name: 'McCann Cafe',
    building: 'The McCann Center',
    keywords: ['mccann cafe', 'mccann center cafe'],
    hours: [
      { days: 'Mon – Thu', hours: '8:00am – 4:00pm' },
      { days: 'Fri',       hours: '8:00am – 3:00pm' },
      { days: 'Sat – Sun', hours: '9:00am – 3:00pm' },
    ],
  },
  {
    name: 'Donnelly Cafe',
    building: 'Donnelly',
    keywords: ['donnelly cafe'],
    hours: [
      { days: 'Mon – Thu', hours: '8:30am – 4:30pm' },
      { days: 'Fri',       hours: '8:30am – 4:00pm' },
      { days: 'Sat – Sun', hours: 'Closed' },
    ],
  },
  {
    name: 'Hudson at Hancock',
    building: 'Hancock',
    keywords: ['hudson at hancock', 'hudson hancock'],
    hours: [
      { days: 'Mon – Thu', hours: '10:00am – 5:00pm' },
      { days: 'Fri – Sun', hours: 'Closed' },
    ],
  },
];

// High-precision terms that unambiguously signal dining intent on their own.
const HIGH_PRECISION_DINING_KEYWORDS = [
  'dining', 'cafeteria', 'dining hall', 'north end', 'murray student center',
];

// Broad food/meal terms that only signal dining intent when paired with a
// context word (hours, open, close, where, menu, food) to avoid false positives
// like "what events include dinner?" or "can I eat in the library?".
const BROAD_DINING_KEYWORDS = [
  'food', 'eat', 'eating', 'meal', 'hungry',
  'lunch', 'dinner', 'breakfast', 'brunch',
];

// Context words that, when co-occurring with a broad dining keyword, confirm
// the user is asking about dining operations rather than using food language incidentally.
const DINING_CONTEXT_WORDS = [
  'open', 'close', 'hour', 'time', 'when', 'where', 'menu',
  'serve', 'serving', 'available', 'get food', 'grab',
];

const MENU_KEYWORDS = [
  'menu', "what's for", 'whats for', 'what is for',
  "what's on", 'whats on', 'serving today', "today's food",
];

// Flatten all location keyword lists for efficient matching
const ALL_LOCATION_KEYWORDS = LOCATIONS.flatMap(loc => loc.keywords);

// Format a single location as a small markdown table
function formatLocation(loc) {
  const rows = loc.hours.map(h => `| ${h.days} | ${h.hours} |`).join('\n');
  return `**${loc.name}** *(${loc.building})*\n| Days | Hours |\n|------|-------|\n${rows}`;
}

const LIVE_HOURS_NOTE = `\n\n> ⚠️ Hours may vary on holidays or special events. Always confirm at the live site:\n> 🔗 **[Check Live Dining Hours](${DINING_HOURS_URL})**\n\n*[Source: Marist Dining – Hours of Operation](${DINING_HOURS_URL})*`;

/**
 * Returns true if the lowercased message is a dining-related query.
 *
 * Matches if ANY of the following is true:
 *  - A high-precision dining term is present ("dining", "cafeteria", etc.)
 *  - A specific location name is present ("halal shack", "saxbys", etc.)
 *  - A broad food/meal term ("lunch", "eat", etc.) co-occurs with a dining
 *    context word ("open", "hours", "menu", "where", etc.) — this prevents
 *    incidental food language in event/library/office queries from triggering
 *    the dining intercept.
 */
const isDiningQuery = (lowerMessage) => {
  if (HIGH_PRECISION_DINING_KEYWORDS.some(kw => lowerMessage.includes(kw))) return true;
  if (ALL_LOCATION_KEYWORDS.some(kw => lowerMessage.includes(kw))) return true;

  const hasBroadTerm    = BROAD_DINING_KEYWORDS.some(kw => lowerMessage.includes(kw));
  const hasContextWord  = DINING_CONTEXT_WORDS.some(kw => lowerMessage.includes(kw));
  return hasBroadTerm && hasContextWord;
};

/**
 * Returns a markdown-formatted response string for the given dining query.
 * Menu queries always receive the live menu link.
 * Location-specific queries receive that location's hours table.
 * General queries receive the full hours list for all locations.
 */
function getDiningResponse(lowerMessage) {
  // Menu queries: we cannot provide live menu data, redirect to official site
  if (MENU_KEYWORDS.some(kw => lowerMessage.includes(kw))) {
    return (
      "I don't have access to the live daily dining menu, but you can view today's full menu directly on the Marist Dining website:\n\n" +
      `🔗 **[View Today's Menu](${DINING_MENU_URL})**\n\n` +
      `*[Source: Marist Dining – What's on the Menu](${DINING_MENU_URL})*`
    );
  }

  // Location-specific query: return only that location's hours
  const matched = LOCATIONS.find(loc =>
    loc.keywords.some(kw => lowerMessage.includes(kw))
  );
  if (matched) {
    return (
      `Here are the typical semester hours for **${matched.name}** at ${matched.building}:\n\n` +
      formatLocation(matched) +
      LIVE_HOURS_NOTE
    );
  }

  // General dining query: return all locations grouped by building
  const allHours = LOCATIONS.map(formatLocation).join('\n\n');
  return (
    'Here are the typical semester hours for all Marist dining locations:\n\n' +
    allHours +
    LIVE_HOURS_NOTE
  );
}

// Sources array to include in the MAPLE response envelope for dining responses
const DINING_SOURCES = [
  {
    title: 'Marist Dining – Hours of Operation',
    url: DINING_HOURS_URL,
    chunk_id: 'hardcoded_dining_hours',
    relevance_score: 1.0,
  },
  {
    title: "Marist Dining – What's on the Menu",
    url: DINING_MENU_URL,
    chunk_id: 'hardcoded_dining_menu',
    relevance_score: 1.0,
  },
];

module.exports = { isDiningQuery, getDiningResponse, DINING_SOURCES };
