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
 *  4a. Intercepts dining queries before RAG and returns hardcoded typical semester
 *     hours or a menu link (dineoncampus.com is Cloudflare-protected; no scraping)
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
const diningUtils = require('../utils/dining');
const { evaluateDataFreshness } = require('../utils/dataFreshness');

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

    // Acquire the pool once and reuse it for both the history fetch and the final write
    const pool = retrievalService.getDbPool();

    // Exact match mapping for metadata pre-filtering
    let domainFilter = null;
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.includes('library')) domainFilter = 'Library';
    else if (lowerMessage.includes('health') || lowerMessage.includes('immunization') || lowerMessage.includes('wellness')) domainFilter = 'Health';
    else if (lowerMessage.includes('wifi') || lowerMessage.includes('print')) domainFilter = 'IT Support';
    else if (lowerMessage.includes('event')) domainFilter = 'Events';
    else if (lowerMessage.includes('intramural') || /\brecreation\b/.test(lowerMessage)) domainFilter = 'Recreation';
    else if (lowerMessage.includes('gym') || lowerMessage.includes('pool')) domainFilter = 'RecCenter';
    else if (lowerMessage.includes('club') || lowerMessage.includes('organization')) domainFilter = 'Clubs';
    else if (lowerMessage.includes('news') || lowerMessage.includes('marist circle')) domainFilter = 'News';
    else if (lowerMessage.includes('directory') ||/\boffices?\b/.test(lowerMessage)) domainFilter = 'Admin';

    // Dining queries are intercepted before RAG since dineoncampus.com is protected
    // by Cloudflare and automated scraping is unreliable. Hardcoded typical semester
    // hours and official links are returned directly without hitting the LLM.
    if (diningUtils.isDiningQuery(lowerMessage)) {
      const diningFreshness = {
        status: 'aging',
        warning: 'Dining information reflects typical semester schedules and may change during holidays or special events. Please verify details on official Marist dining pages.',
        oldest_source_age_hours: null,
        stale_sources: []
      };

      return res.status(200).json({
        success: true,
        data: {
          response: diningUtils.getDiningResponse(lowerMessage),
          conversation_id: activeConversationId,
          sources: diningUtils.DINING_SOURCES,
          confidence: 'high',
          freshness: diningFreshness
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
      conversationId: activeConversationId
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