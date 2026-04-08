const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Cost constants for text-embedding-3-small and a standard frontier model (e.g., gpt-4o-mini)
const PRICING = {
  input: 0.00015 / 1000, 
  output: 0.00060 / 1000
};

/**
 * Shared service layer for LLM API calls.
 *
 */
const llmService = {
  async complete({ systemPrompt, messages, model = 'gpt-4o-mini', maxTokens = 1024, temperature = 0.3 }) {
    const startTime = Date.now();
    
    // Construct the payload with the system prompt isolated from user input
    const payloadMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    try {
      // Enforce the mandated timeout (e.g., 30 seconds)
      const response = await Promise.race([
        openai.chat.completions.create({
          model,
          messages: payloadMessages,
          max_tokens: maxTokens,
          temperature,
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('LLM_TIMEOUT')), 30000)
        )
      ]);

      const latencyMs = Date.now() - startTime;
      const inputTokens = response.usage.prompt_tokens;
      const outputTokens = response.usage.completion_tokens;
      const estimatedCost = (inputTokens * PRICING.input) + (outputTokens * PRICING.output);

      // Structure designed to easily pipe into the required logging schema
      return {
        success: true,
        content: response.choices[0].message.content,
        usage: {
          inputTokens,
          outputTokens,
          costUsd: parseFloat(estimatedCost.toFixed(6))
        },
        latencyMs
      };

    } catch (error) {
      const latencyMs = Date.now() - startTime;
      console.error('[LLM Service Error]:', error.message);
      
      // Normalize errors from the LLM provider
      return {
        success: false,
        content: null,
        error: error.message === 'LLM_TIMEOUT' ? 'Request timed out' : 'Provider error',
        latencyMs
      };
    }
  }
};

module.exports = llmService;