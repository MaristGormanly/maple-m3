/**
 * server/src/controllers/chat.js — Chat Request Handler
 *
 * Orchestrates the full RAG pipeline for a single POST /api/v1/campus/chat request:
 *  1. Validates the incoming message field
 *  2. Assigns or inherits a conversation_id for multi-turn context tracking
 *  3. Fetches the last 5 turns from ChatHistory for the active conversation_id
 *     and prepends them to the LLM messages array so the model has memory of
 *     prior exchanges within the same session
 *  4. Applies keyword-based domain pre-filtering (Library, Health, IT, Events, etc.)
 *     to narrow the vector search before embedding
 *  4a. Routes dining queries to Dining retrieval first; if no chunks are found,
 *     falls back to hardcoded typical semester hours and a live menu link
 *  5. Calls retrievalService.search() to embed the query and fetch the top-k chunks
 *     from PostgreSQL + pgvector above the configured similarity threshold
 *  6. Returns a RETRIEVAL_FAILED (422) response if no chunks meet the threshold,
 *     bypassing the LLM entirely to prevent hallucination
 *  7. Calculates a confidence level (high / medium / low) from the top retrieval score
 *  8. Injects retrieved chunks and the current timestamp into the system prompt loaded
 *     from prompts/system/main-system-prompt.md (loaded dynamically per request)
 *  9. Calls llmService.complete() with the full history + current message array
 *     and handles AI_ERROR (502) on failure
 * 10. Persists the query and AI response to the ChatHistory table
 * 11. Returns the MAPLE standard response envelope with response, conversation_id,
 *     sources[], confidence, and metadata (model, latency_ms)
 *
 * All error paths return a MAPLE-compliant error envelope (success: false).
 */
const fs = require('fs');
const path = require('path');
const retrievalService = require('../services/retrieval');
const llmService = require('../services/llm');
const { evaluateDataFreshness } = require('../utils/dataFreshness');
const { isDiningQuery, buildDiningResponse } = require('../utils/dining');

const PROMPT_LEAK_PATTERNS = [
  /system context:/i,
  /constraints\s*&\s*guardrails:/i,
  /retrieved context:/i
];

const ROLE_IMPERSONATION_PATTERNS = [
  /pretend to be .*registrar/i,
  /act as .*registrar/i,
  /approve my graduation/i,
  /impersonate .*office/i
];

const OUT_OF_SCOPE_ACADEMIC_PATTERNS = [
  /french revolution/i,
  /napoleon/i,
  /bastille/i,
  /reign of terror/i,
  /write me (a|an) .*essay/i,
  /write .*essay/i,
  /do my homework/i,
  /help with homework/i,
  /summarize .*history/i,
  /explain .*history/i,
  /\bessay\b/i,
  /\bhomework\b/i,
  /\bassignment\b/i
];

const PROMPT_EXFILTRATION_REQUEST_PATTERNS = [
  /system prompt/i,
  /internal instructions/i,
  /hidden context/i,
  /word for word/i,
  /verbatim/i,
  /reveal .*prompt/i,
  /show .*instructions/i
];

const CAMPUS_CONTEXT_HINTS = [
  'marist', 'campus', 'library', 'dining', 'health', 'wifi', 'printing', 'it',
  'registrar', 'financial aid', 'club', 'event', 'gym', 'pool', 'intramural', 'directory'
];

const NON_CAMPUS_TOPIC_PATTERNS = [
  /french revolution/i,
  /american revolution/i,
  /world war [12]/i,
  /napoleon/i,
  /bastille/i,
  /reign of terror/i,
  /\broman empire\b/i,
  /\bmitosis\b/i,
  /\bphotosynthesis\b/i
];

function hasPromptLeakIndicators(text, userMessage) {
  if (!text || typeof text !== 'string') return false;
  const matchCount = PROMPT_LEAK_PATTERNS.filter((pattern) => pattern.test(text)).length;
  if (matchCount === 0) return false;

  // If the user asked for internals, any marker is a leak signal.
  if (isPromptExfiltrationRequest(userMessage)) return true;

  // For regular campus queries, only block when multiple internal sections are exposed.
  return matchCount >= 2;
}

function isRoleImpersonationRequest(text) {
  if (!text || typeof text !== 'string') return false;
  return ROLE_IMPERSONATION_PATTERNS.some((pattern) => pattern.test(text));
}

function isOutOfScopeAcademicRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = text.toLowerCase();
  const hasOutOfScopeSignal = OUT_OF_SCOPE_ACADEMIC_PATTERNS.some((pattern) => pattern.test(text));
  const hasCampusSignal = CAMPUS_CONTEXT_HINTS.some((hint) => normalized.includes(hint));
  return hasOutOfScopeSignal && !hasCampusSignal;
}

function isHardBlockedNonCampusTopic(text) {
  if (!text || typeof text !== 'string') return false;
  return NON_CAMPUS_TOPIC_PATTERNS.some((pattern) => pattern.test(text));
}

function isPromptExfiltrationRequest(text) {
  if (!text || typeof text !== 'string') return false;
  return PROMPT_EXFILTRATION_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

function buildPromptLeakSafeResponse() {
  return {
    response: "I can't help with that. I can still help with campus services questions like dining, library, events, IT, health, and clubs.",
    sources: [],
    confidence: 'none',
    freshness: {
      status: 'unknown',
      warning: null,
      oldest_source_age_hours: null,
      stale_sources: []
    }
  };
}

function buildPolicyRefusalResponse() {
  return {
    response: "I can only help with Marist campus services topics. I can't assist with role impersonation or unrelated essay/homework requests. For campus administrative actions, please contact the official office directly.",
    sources: [],
    confidence: 'none',
    freshness: {
      status: 'unknown',
      warning: null,
      oldest_source_age_hours: null,
      stale_sources: []
    }
  };
}

function resolveLlmModelName() {
  return process.env.USE_LOCAL_MODEL === 'true' ? 'llama3.1:8b' : 'gpt-4o-mini';
}

const handleChat = async (req, res) => {
  const timestamp = new Date().toISOString();
  const MAPLE_VERSION = "1.0.0";
  
  // Dynamically load the prompt on every request so changes don't require a restart
  const promptPath = path.join(__dirname, '../../../prompts/system/main-system-prompt.md');
  const rawSystemPrompt = fs.readFileSync(promptPath, 'utf8');
  
  try {
    const { message, conversation_id, context } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: 'VALIDATION_ERROR', message: 'Message is required.' },
        metadata: { timestamp, module: "m3", version: MAPLE_VERSION }
      });
    }

    const activeConversationId = conversation_id || `conv_${Date.now()}`;
    const lowerMessage = message.toLowerCase();
    const isDiningIntent = isDiningQuery(message);
    const isEvalRequest = String(req.headers['x-maple-eval'] || '').toLowerCase() === 'true';

    if (
      isPromptExfiltrationRequest(message) ||
      isRoleImpersonationRequest(message) ||
      isOutOfScopeAcademicRequest(message) ||
      isHardBlockedNonCampusTopic(message)
    ) {
      const safePayload = buildPolicyRefusalResponse();
      return res.status(200).json({
        success: true,
        data: {
          ...safePayload,
          conversation_id: activeConversationId
        },
        error: null,
        metadata: {
          timestamp,
          module: "m3",
          version: MAPLE_VERSION,
          model: 'policy-guard',
          latency_ms: 0
        }
      });
    }

    // Acquire the pool once and reuse it for both the history fetch and the final write
    const pool = retrievalService.getDbPool();

    // Exact match mapping for metadata pre-filtering
    let domainFilter = null;

    if (isDiningIntent) domainFilter = 'Dining';
    else if (lowerMessage.includes('library')) domainFilter = 'Library';
    else if (lowerMessage.includes('health') || lowerMessage.includes('immunization') || lowerMessage.includes('wellness')) domainFilter = 'Health';
    else if (lowerMessage.includes('wifi') || lowerMessage.includes('print')) domainFilter = 'IT Support';
    else if (lowerMessage.includes('event')) domainFilter = 'Events';
    else if (lowerMessage.includes('intramural') || /\brecreation\b/.test(lowerMessage)) domainFilter = 'Recreation';
    else if (lowerMessage.includes('gym') || lowerMessage.includes('pool')) domainFilter = 'RecCenter';
    else if (lowerMessage.includes('club') || lowerMessage.includes('organization')) domainFilter = 'Clubs';
    else if (lowerMessage.includes('news') || lowerMessage.includes('marist circle')) domainFilter = 'News';
    else if (lowerMessage.includes('directory') ||/\boffices?\b/.test(lowerMessage)) domainFilter = 'Admin';


    // Pass conversationId for correlation logging
    const retrievalResult = await retrievalService.search(message, domainFilter, activeConversationId);

    if (!retrievalResult.success) {
      return res.status(500).json({
        success: false,
        data: null,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Retrieval service failed.',
          details: retrievalResult.error || 'Embedding or database error during vector search.'
        },
        metadata: {
          timestamp,
          module: 'm3',
          version: MAPLE_VERSION,
          ...(retrievalResult.metadata || {})
        }
      });
    }

    if (retrievalResult.chunks.length === 0) {
      if (isDiningIntent) {
        const diningPayload = buildDiningResponse();
        return res.status(200).json({
          success: true,
          data: {
            ...diningPayload,
            conversation_id: activeConversationId
          },
          error: null,
          metadata: {
            timestamp,
            module: 'm3',
            version: MAPLE_VERSION,
            model: 'hardcoded',
            latency_ms: 0
          }
        });
      }

      const thresholdApplied = retrievalResult.metadata?.threshold_applied ?? 0.55;
    
      return res.status(422).json({
        success: false,
        data: null,
        error: {
          code: 'RETRIEVAL_FAILED',
          message:
            "I'm sorry, I couldn't find any specific campus information in my database to answer that accurately. Could you try rephrasing or asking about library hours, dining, or IT?",
          details: `No chunks exceeded the similarity threshold of ${thresholdApplied}.`,
          conversation_id: activeConversationId,
          sources: [],
          confidence: 'none'
        },
        metadata: {
          timestamp,
          module: 'm3',
          version: MAPLE_VERSION,
          ...retrievalResult.metadata
        }
      });
    }

    const chunks = retrievalResult.chunks;
    const freshness = evaluateDataFreshness(chunks);
    const sources = chunks.map(chunk => ({
      title: chunk.source_title,
      url: chunk.source_url, 
      chunk_id: `doc_${chunk.doc_id}_chunk_${chunk.chunk_index}`, 
      relevance_score: parseFloat(chunk.relevance_score.toFixed(4))
    }));

    let confidence = 'low';
    const topScore = retrievalResult.metadata.top_score ?? 0;
    if (topScore >= 0.75) confidence = 'high';
    else if (topScore >= 0.60) confidence = 'medium';

    // Inject optional User Context
    const userContextStr = context && Object.keys(context).length > 0 
      ? `\n\nUSER PROFILE CONTEXT:\n${JSON.stringify(context, null, 2)}\n(Use this profile data to personalize your response if relevant).`
      : '';

    const currentTimestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const contextText = chunks.map((c) => `[Source: ${c.source_title} | Last Updated: ${c.last_updated}]\n${c.content}`).join('\n\n');
    
    const systemPrompt = rawSystemPrompt
      .replace('{{CURRENT_TIMESTAMP}}', currentTimestamp)
      .replace('{{CONTEXT}}', contextText + userContextStr);

    // Load prior turns so the LLM can answer follow-up questions in context.
    // Only fetched when the client sends back an existing conversation_id (i.e. not
    // the first message). Capped at 5 prior exchanges to keep token usage bounded.
    // Failure to load history degrades gracefully — the request continues without it.
    let historyMessages = [];
    if (conversation_id) {
      try {
        const historyResult = await pool.query(
          `SELECT query_message, ai_response
           FROM ChatHistory
           WHERE conversation_id = $1
           ORDER BY timestamp ASC
           LIMIT 5`,
          [activeConversationId]
        );
        for (const row of historyResult.rows) {
          historyMessages.push({ role: 'user',      content: row.query_message });
          historyMessages.push({ role: 'assistant', content: row.ai_response  });
        }
      } catch (histErr) {
        console.error('Failed to load conversation history:', histErr.message);
      }
    }

    const llmResult = await llmService.complete({
      systemPrompt,
      messages: [...historyMessages, { role: 'user', content: message }],
      conversationId: activeConversationId,
      temperature: isEvalRequest ? 0 : 0.3
    });

    if (!llmResult.success) {
      return res.status(502).json({
        success: false,
        data: null,
        error: {
          code: 'AI_ERROR',
          message: 'LLM API call failed or returned unusable output',
          details: llmResult.error || undefined
        },
        metadata: {
          timestamp,
          module: 'm3',
          version: MAPLE_VERSION,
          model: llmResult.model || resolveLlmModelName(),
          ...retrievalResult.metadata
        }
      });
    }

    if (hasPromptLeakIndicators(llmResult.content, message)) {
      const safePayload = buildPromptLeakSafeResponse();
      return res.status(200).json({
        success: true,
        data: {
          ...safePayload,
          conversation_id: activeConversationId
        },
        error: null,
        metadata: {
          timestamp,
          module: "m3",
          version: MAPLE_VERSION,
          model: 'policy-guard',
          latency_ms: llmResult.latencyMs
        }
      });
    }

    // Persist this turn so it is available as history for future requests
    try {
      await pool.query(`
        INSERT INTO ChatHistory (conversation_id, query_message, ai_response) 
        VALUES ($1, $2, $3)
      `, [activeConversationId, message, llmResult.content]);
    } catch (poolErr) {
      console.error("Failed to insert ChatHistory:", poolErr.message);
    }

    return res.status(200).json({
      success: true,
      data: {
        response: llmResult.content,
        conversation_id: activeConversationId,
        sources: sources,
        confidence: confidence,
        freshness
      },
      error: null,
      metadata: {
        timestamp,
        module: "m3",
        version: MAPLE_VERSION,
        model: llmResult.model,
        latency_ms: llmResult.latencyMs
      }
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      data: null,
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' },
      metadata: { timestamp, module: "m3", version: MAPLE_VERSION }
    });
  }
};

module.exports = { handleChat };