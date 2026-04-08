const { OpenAI } = require('openai');

let openai;
// Initialize the client based on the environment toggle
if (process.env.USE_LOCAL_MODEL === 'true') {
  openai = new OpenAI({
    baseURL: 'http://localhost:11434/v1', 
    apiKey: 'ollama', 
  });
} else {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// Cost constants for cloud models
const PRICING = {
  input: 0.00015 / 1000, 
  output: 0.00060 / 1000
};

const llmService = {
  async complete({ systemPrompt, messages, model, maxTokens = 1024, temperature = 0.3 }) {
    const startTime = Date.now();
    
    const payloadMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    // Determine the default model based on the environment
    let targetModel = model;
    if (!targetModel) {
      targetModel = process.env.USE_LOCAL_MODEL === 'true' ? 'llama3.1:8b' : 'gpt-4o-mini';
    }

    try {
      const response = await Promise.race([
        openai.chat.completions.create({
          model: targetModel,
          messages: payloadMessages,
          max_tokens: maxTokens,
          temperature,
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('LLM_TIMEOUT')), 30000)
        )
      ]);

      const latencyMs = Date.now() - startTime;
      const inputTokens = response.usage?.prompt_tokens || 0;
      const outputTokens = response.usage?.completion_tokens || 0;
      
      // Calculate cost: Spark is free, OpenAI costs money
      let estimatedCost = 0;
      if (process.env.USE_LOCAL_MODEL !== 'true') {
        estimatedCost = (inputTokens * PRICING.input) + (outputTokens * PRICING.output);
      }

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