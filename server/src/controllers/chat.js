const fs = require('fs');
const path = require('path');
const retrievalService = require('../services/retrieval');
const llmService = require('../services/llm');

const promptPath = path.join(__dirname, '../../../prompts/system/main-system-prompt.md');
const rawSystemPrompt = fs.readFileSync(promptPath, 'utf8');

const handleChat = async (req, res) => {
  const timestamp = new Date().toISOString();
  const MAPLE_VERSION = "1.0.0";
  
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

    // Exact match mapping for metadata pre-filtering
    let domainFilter = null;
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('dining') || lowerMessage.includes('food')) domainFilter = 'Dining';
    else if (lowerMessage.includes('library')) domainFilter = 'Library';
    else if (lowerMessage.includes('it') || lowerMessage.includes('wifi')) domainFilter = 'IT/FAQ';
    else if (lowerMessage.includes('event')) domainFilter = 'Events';
    else if (lowerMessage.includes('gym') || lowerMessage.includes('pool')) domainFilter = 'Rec/Pool';

    // Pass conversationId for correlation logging
    const retrievalResult = await retrievalService.search(message, domainFilter, activeConversationId);

    if (!retrievalResult.success || retrievalResult.chunks.length === 0) {
      return res.status(422).json({
        success: false,
        data: null, 
        error: { code: 'RETRIEVAL_FAILED', message: 'Unable to find relevant information for your query.' },
        metadata: { timestamp, module: "m3", version: MAPLE_VERSION }
      });
    }

    const chunks = retrievalResult.chunks;
    const sources = chunks.map(chunk => ({
      title: chunk.source_title,
      url: chunk.source_url, 
      chunk_id: `doc_${chunk.doc_id}_chunk_${chunk.chunk_index}`, 
      relevance_score: parseFloat(chunk.relevance_score.toFixed(4))
    }));

    let confidence = 'low';
    const topScore = retrievalResult.metadata.top_score;
    if (topScore >= 0.85) confidence = 'high';
    else if (topScore >= 0.75) confidence = 'medium';

    // Inject optional User Context
    const userContextStr = context && Object.keys(context).length > 0 
      ? `\n\nUSER PROFILE CONTEXT:\n${JSON.stringify(context, null, 2)}\n(Use this profile data to personalize your response if relevant).`
      : '';

    const currentTimestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const contextText = chunks.map((c) => `[Source: ${c.source_title} | Last Updated: ${c.last_updated}]\n${c.content}`).join('\n\n');
    
    const systemPrompt = rawSystemPrompt
      .replace('{{CURRENT_TIMESTAMP}}', currentTimestamp)
      .replace('{{CONTEXT}}', contextText + userContextStr);

    const llmResult = await llmService.complete({
      systemPrompt,
      messages: [{ role: 'user', content: message }],
      conversationId: activeConversationId
    });

    if (!llmResult.success) {
      return res.status(502).json({
        success: false,
        data: null,
        error: { code: 'AI_ERROR', message: llmResult.error },
        metadata: { timestamp, module: "m3", version: MAPLE_VERSION }
      });
    }

    // Persist with conversation_id safely
    const db = retrievalService.getDbClient();
    try {
      await db.query(`
        INSERT INTO ChatHistory (conversation_id, query_message, ai_response) 
        VALUES ($1, $2, $3)
      `, [activeConversationId, message, llmResult.content]);
    } catch (dbErr) {
      console.error("Failed to insert ChatHistory:", dbErr.message);
    }

    return res.status(200).json({
      success: true,
      data: {
        response: llmResult.content,
        conversation_id: activeConversationId,
        sources: sources,
        confidence: confidence
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