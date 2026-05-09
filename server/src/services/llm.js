/**
 * server/src/services/llm.js — LLM API Wrapper Service
 *
 * Single entry point for all LLM generation calls in the MAPLE M3 backend,
 * per the Architecture Guide requirement that every module route LLM calls through
 * a shared service layer with structured logging and error handling built in.
 *
 * Provider selection (controlled by USE_LOCAL_MODEL env var):
 *  - true:  Ollama on the campus NVIDIA DGX Spark (llama3.1:8b), baseURL via SSH tunnel
 *  - false: OpenAI API (gpt-4o-mini), requires OPENAI_API_KEY
 *
 * complete({ systemPrompt, messages, maxTokens, temperature, conversationId }):
 *  - Prepends the system prompt to the messages array before sending to the provider
 *  - Races the API call against a 30-second timeout to prevent hung requests
 *  - Retries up to 2 times with exponential backoff on transient failures;
 *    skips retries immediately for 4xx client errors (bad prompt, invalid key, etc.)
 *  - Tracks and returns latency, token usage, and estimated cost per call
 *  - Logs every attempt (success or failure) as a structured JSON event via logger
 *  - Returns { success, content, model, usage, latencyMs } on success
 *    or { success: false, error, model, latencyMs } on failure
 */
const { OpenAI } = require('openai');
const logger = require('../utils/logger');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

let openai;
let targetModel;

if (process.env.USE_LOCAL_MODEL === 'true') {
  openai = new OpenAI({ baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' });
  targetModel = 'llama3.1:8b';
} else {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  targetModel = 'gpt-4o-mini';
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const llmService = {
  async complete({ systemPrompt, messages, maxTokens = 1024, temperature = 0.3, conversationId = 'unknown' }) {
    const payloadMessages = [{ role: 'system', content: systemPrompt }, ...messages];

    let attempt = 0;
    const maxRetries = 2;
    const startTime = Date.now();

    while (attempt <= maxRetries) {
      try {
        const response = await Promise.race([
          openai.chat.completions.create({
            model: targetModel,
            messages: payloadMessages,
            max_tokens: maxTokens,
            temperature,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('LLM_TIMEOUT')), 30000))
        ]);

        const latencyMs = Date.now() - startTime;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        
        const costUsd = process.env.USE_LOCAL_MODEL === 'true' 
          ? 0.00 
          : (inputTokens * (0.00015/1000)) + (outputTokens * (0.00060/1000));

        logger.logLLMCall({
          conversation_id: conversationId,
          model: targetModel,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          latency_ms: latencyMs,
          estimated_cost_usd: costUsd,
          success: true,
          error: null
        });

        return {
          success: true,
          content: response.choices[0].message.content,
          model: targetModel,
          usage: { inputTokens, outputTokens, costUsd },
          latencyMs
        };

      } catch (error) {
        attempt++;
        const isTimeout = error.message === 'LLM_TIMEOUT';
        
        // Fix: Safely check error status (e.g., 400s usually mean bad prompt, no need to retry)
        const status = error?.status || 500;
        
        if (attempt > maxRetries || (!isTimeout && status >= 400 && status < 500)) {
          const latencyMs = Date.now() - startTime;
          logger.logLLMCall({
            conversation_id: conversationId,
            model: targetModel,
            latency_ms: latencyMs,
            success: false,
            error: isTimeout ? 'Request timed out' : error.message
          });

          return {
            success: false,
            content: null,
            model: targetModel,
            error: isTimeout ? 'Request timed out' : 'Provider error',
            latencyMs
          };
        }
        await wait(Math.pow(2, attempt - 1) * 1000);
      }
    }
    return {
      success: false,
      content: null,
      model: targetModel,
      error: 'Max retries exceeded or unexpected LLM failure',
      latencyMs: Date.now() - startTime
    };
  }
};

module.exports = llmService;