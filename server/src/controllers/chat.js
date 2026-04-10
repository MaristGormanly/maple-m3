const fs = require('fs');
const path = require('path');
const retrievalService = require('../services/retrieval');
const llmService = require('../services/llm');

const PROMPT_TEMPLATE_PATH = path.join(
  __dirname,
  '../../../prompts/system/main-system-prompt.md'
);

function buildSystemPrompt(currentTimestamp, contextText) {
  const template = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');
  return template
    .replaceAll('{{CURRENT_TIMESTAMP}}', currentTimestamp)
    .replaceAll('{{CONTEXT}}', contextText);
}

const handleChat = async (req, res) => {
  try {
    const { message, conversation_id } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: 'VALIDATION_ERROR', message: 'Message is required in the request payload.' },
        metadata: {}
      });
    }

    // 1. Retrieve Context from the Vector Database
    const retrievalResult = await retrievalService.search(message);

    // 2. Handle Retrieval Failure (Threshold < 0.70)
    if (!retrievalResult.success || retrievalResult.chunks.length === 0) {
      return res.status(422).json({
        success: false,
        data: {
          response: "I don't have enough information to answer that. Please contact the relevant campus office.",
          sources: [],
          confidence: "none" // Flagged as 'none' when threshold fails
        },
        error: { code: 'RETRIEVAL_FAILED', message: 'No relevant context found meeting the similarity threshold.' },
        metadata: retrievalResult.metadata || {}
      });
    }

    // 3. Format Sources and Calculate Confidence Flag
    const chunks = retrievalResult.chunks;
    const sources = chunks.map(chunk => ({
      title: chunk.source_title,
      url: chunk.source_url,
      type: chunk.source_type,
      relevance: chunk.relevance_score
    }));

    let confidence = 'low';
    const topScore = parseFloat(retrievalResult.metadata.top_score);
    if (topScore >= 0.85) confidence = 'high';
    else if (topScore >= 0.75) confidence = 'medium';

    const currentTimestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const contextText = chunks.map((c) => `[Source: ${c.source_title}]\n${c.content}`).join('\n\n');
    const systemPrompt = buildSystemPrompt(currentTimestamp, contextText);

    // 5. Generate the Answer via LLM Service (DGX Spark)
    const llmResult = await llmService.complete({
      systemPrompt,
      messages: [{ role: 'user', content: message }]
    });

    // 6. Handle LLM Failures (Timeouts or Connection Drops)
    if (!llmResult.success) {
      return res.status(502).json({
        success: false,
        data: null,
        error: { code: 'AI_ERROR', message: llmResult.error },
        metadata: retrievalResult.metadata
      });
    }

    // 7. Return the MAPLE Standard Success Envelope
    return res.status(200).json({
      success: true,
      data: {
        response: llmResult.content,
        sources: sources,
        confidence: confidence
      },
      error: null,
      metadata: {
        ...retrievalResult.metadata,
        llm_usage: llmResult.usage,
        latency_ms: llmResult.latencyMs
      }
    });

  } catch (error) {
    console.error('[Chat Controller Fatal Error]:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred during processing.' },
      metadata: {}
    });
  }
};

module.exports = { handleChat };