import express from 'express';
import fetch from 'node-fetch';
import { getConfig, getModelById, getEndpointByType, getSystemPrompt, getModelReasoning, getRedirectedModelId, getModelProvider } from './config.js';
import { logInfo, logDebug, logError, logRequest, logResponse } from './logger.js';
import { transformToAnthropic, getAnthropicHeaders } from './transformers/request-anthropic.js';
import { transformToOpenAI, getOpenAIHeaders } from './transformers/request-openai.js';
import { transformToCommon, getCommonHeaders } from './transformers/request-common.js';
import { AnthropicResponseTransformer } from './transformers/response-anthropic.js';
import { OpenAIResponseTransformer } from './transformers/response-openai.js';
import { getApiKey, rotateFactoryApiKey, hasMoreFactoryKeys, getCurrentKeyInfo, startNewRotationCycle, didRotationOccur } from './auth.js';
import { getNextProxyAgent } from './proxy-manager.js';

const router = express.Router();

/**
 * Check if error response indicates quota exceeded or auth failure
 * Status codes: 429 (quota), 401/403 (auth), 402 (payment required)
 */
function isQuotaOrAuthError(statusCode) {
  return statusCode === 429 || statusCode === 401 || statusCode === 403 || statusCode === 402;
}

/**
 * Make a fetch request with automatic Factory API key fallback on quota/auth errors
 * @param {string} url - The endpoint URL
 * @param {object} fetchOptions - Fetch options (method, headers, body)
 * @param {string} endpointName - Name for logging (e.g., "chat completions")
 * @returns {Promise<Response>} - The fetch response
 */
async function fetchWithFallback(url, fetchOptions, endpointName) {
  let lastError = null;
  let attempt = 1;
  const maxAttempts = 10; // Allow trying all keys (up to 7) plus retries

  // Start a new rotation cycle for this request
  startNewRotationCycle();

  while (attempt <= maxAttempts) {
    try {
      const keyInfo = getCurrentKeyInfo();
      if (keyInfo) {
        logInfo(`[Attempt ${attempt}/${maxAttempts}] Using Factory API key #${keyInfo.index}/${keyInfo.total} for ${endpointName}`);
      }

      const response = await fetch(url, fetchOptions);

      // Check if we got a quota or auth error
      if (isQuotaOrAuthError(response.status)) {
        // Clone response before reading body so original can still be returned
        const responseClone = response.clone();
        const errorText = await responseClone.text();

        console.log('\n' + '='.repeat(80));
        console.log('⚠️  API KEY FAILURE DETECTED');
        console.log('='.repeat(80));
        console.log(`Endpoint: ${endpointName}`);
        console.log(`Status: ${response.status}`);
        console.log(`Error: ${errorText.substring(0, 200)}`);
        console.log(`Attempt: ${attempt}/${maxAttempts}`);
        console.log('='.repeat(80) + '\n');

        logError(`Factory API key failed with status ${response.status}`, new Error(errorText));

        // Try to rotate to next key if available
        if (hasMoreFactoryKeys()) {
          const rotated = rotateFactoryApiKey();
          if (rotated) {
            // Update the Authorization header with new key
            const newAuthHeader = await getApiKey();
            fetchOptions.headers.authorization = newAuthHeader;

            logInfo(`Retrying ${endpointName} with fallback key...`);
            attempt++;
            continue; // Retry with new key
          }
        }

        // No more keys to try, return the original response (body not consumed)
        logError(`All Factory API keys exhausted for ${endpointName}`, new Error('No more fallback keys available - tried all keys in cycle'));
        return response;
      }

      // Success! Log only if rotation actually happened in this request
      if (didRotationOccur()) {
        const keyInfo2 = getCurrentKeyInfo();
        if (keyInfo2) {
          console.log('\n' + '='.repeat(80));
          console.log('✅ FALLBACK KEY SUCCESS');
          console.log('='.repeat(80));
          console.log(`Endpoint: ${endpointName}`);
          console.log(`Active key: #${keyInfo2.index}/${keyInfo2.total}`);
          console.log(`Status: ${response.status}`);
          console.log('='.repeat(80) + '\n');
        }
      }

      return response;

    } catch (error) {
      lastError = error;
      logError(`Network error on attempt ${attempt}/${maxAttempts}`, error);

      // Don't retry on network errors, just throw
      throw error;
    }
  }

  // Should not reach here, but just in case
  throw lastError || new Error('Request failed after all attempts');
}

/**
 * Convert a /v1/responses API result to a /v1/chat/completions-compatible format.
 * Works for non-streaming responses.
 */
function convertResponseToChatCompletion(resp) {
  if (!resp || typeof resp !== 'object') {
    throw new Error('Invalid response object');
  }

  const outputMsg = (resp.output || []).find(o => o.type === 'message');
  const textBlocks = outputMsg?.content?.filter(c => c.type === 'output_text') || [];
  const content = textBlocks.map(c => c.text).join('');

  const chatCompletion = {
    id: resp.id ? resp.id.replace(/^resp_/, 'chatcmpl-') : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: resp.created_at || Math.floor(Date.now() / 1000),
    model: resp.model || 'unknown-model',
    choices: [
      {
        index: 0,
        message: {
          role: outputMsg?.role || 'assistant',
          content: content || ''
        },
        finish_reason: resp.status === 'completed' ? 'stop' : 'unknown'
      }
    ],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: resp.usage?.total_tokens ?? 0
    }
  };

  return chatCompletion;
}

router.get('/v1/models', (req, res) => {
  logInfo('GET /v1/models');
  
  try {
    const config = getConfig();
    const models = config.models.map(model => ({
      id: model.id,
      object: 'model',
      created: Date.now(),
      owned_by: model.type,
      permission: [],
      root: model.id,
      parent: null
    }));

    const response = {
      object: 'list',
      data: models
    };

    logResponse(200, null, response);
    res.json(response);
  } catch (error) {
    logError('Error in GET /v1/models', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 标准 OpenAI 聊天补全处理函数（带格式转换）
async function handleChatCompletions(req, res) {
  logInfo('POST /v1/chat/completions');

  try {
    const openaiRequest = req.body;
    const modelId = getRedirectedModelId(openaiRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Routing to ${model.type} endpoint: ${endpoint.base_url}`);

    // Get API key (will auto-refresh if needed)
    let authHeader;
    try {
      authHeader = await getApiKey(req.headers.authorization);
    } catch (error) {
      logError('Failed to get API key', error);
      return res.status(500).json({ 
        error: 'API key not available',
        message: 'Failed to get or refresh API key. Please check server logs.'
      });
    }

    let transformedRequest;
    let headers;
    const clientHeaders = req.headers;

    // Log received client headers for debugging
    logDebug('Client headers received', {
      'x-factory-client': clientHeaders['x-factory-client'],
      'x-session-id': clientHeaders['x-session-id'],
      'x-assistant-message-id': clientHeaders['x-assistant-message-id'],
      'user-agent': clientHeaders['user-agent']
    });

    // Update request body with redirected model ID before transformation
    const requestWithRedirectedModel = { ...openaiRequest, model: modelId };

    // Get provider from model config
    const provider = getModelProvider(modelId);

    try {
      if (model.type === 'anthropic') {
        transformedRequest = transformToAnthropic(requestWithRedirectedModel);
        const isStreaming = openaiRequest.stream === true;
        headers = getAnthropicHeaders(authHeader, clientHeaders, isStreaming, modelId, provider);
      } else if (model.type === 'openai') {
        transformedRequest = transformToOpenAI(requestWithRedirectedModel);
        headers = getOpenAIHeaders(authHeader, clientHeaders, provider);
      } else if (model.type === 'common') {
        transformedRequest = transformToCommon(requestWithRedirectedModel);
        headers = getCommonHeaders(authHeader, clientHeaders, provider);
      } else {
        return res.status(500).json({ error: `Unknown endpoint type: ${model.type}` });
      }
    } catch (transformError) {
      logError('Request transformation failed', transformError);
      const debugInfo = `[TRANSFORM_ERROR] ${transformError.message} | Type: ${model.type} | Stack: ${transformError.stack?.split('\n').slice(1, 2).join('')}`;
      return res.status(500).json({
        error: {
          message: debugInfo,
          type: 'transform_error',
          code: 'request_transform_failed'
        }
      });
    }

    logRequest('POST', endpoint.base_url, headers, transformedRequest);

    const proxyAgentInfo = getNextProxyAgent(endpoint.base_url);
    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify(transformedRequest)
    };

    if (proxyAgentInfo?.agent) {
      fetchOptions.agent = proxyAgentInfo.agent;
    }

    const response = await fetchWithFallback(endpoint.base_url, fetchOptions, 'chat completions');

    logInfo(`Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `Endpoint returned ${response.status}`,
        details: errorText
      });
    }

    const isStreaming = transformedRequest.stream === true;

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // common 类型直接转发，不使用 transformer
      if (model.type === 'common') {
        try {
          for await (const chunk of response.body) {
            res.write(chunk);
          }
          res.end();
          logInfo('Stream forwarded (common type)');
        } catch (streamError) {
          logError('Stream error', streamError);
          res.end();
        }
      } else {
        // anthropic 和 openai 类型使用 transformer
        let transformer;
        if (model.type === 'anthropic') {
          transformer = new AnthropicResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        } else if (model.type === 'openai') {
          transformer = new OpenAIResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        }

        try {
          for await (const chunk of transformer.transformStream(response.body)) {
            res.write(chunk);
          }
          res.end();
          logInfo('Stream completed');
        } catch (streamError) {
          logError('Stream transformation error', streamError);
          // Send error as SSE event so client can see it
          const errorEvent = `data: ${JSON.stringify({
            error: true,
            message: streamError.message,
            phase: 'response_stream_transform',
            errorType: streamError.constructor.name
          })}\n\n`;
          res.write(errorEvent);
          res.end();
        }
      }
    } else {
      const data = await response.json();
      if (model.type === 'openai') {
        try {
          const converted = convertResponseToChatCompletion(data);
          logResponse(200, null, converted);
          res.json(converted);
        } catch (e) {
          // 如果转换失败，回退为原始数据
          logResponse(200, null, data);
          res.json(data);
        }
      } else {
        // anthropic/common: 保持现有逻辑，直接转发
        logResponse(200, null, data);
        res.json(data);
      }
    }

  } catch (error) {
    logError('Error in /v1/chat/completions', error);
    const debugInfo = `[${error.constructor.name}] ${error.message} | Stack: ${error.stack?.split('\n').slice(1, 3).join(' -> ')}`;
    res.status(500).json({ 
      error: {
        message: debugInfo,
        type: 'proxy_error',
        code: 'internal_error'
      }
    });
  }
}

// 直接转发 OpenAI 请求（不做格式转换）
async function handleDirectResponses(req, res) {
  logInfo('POST /v1/responses');

  try {
    const openaiRequest = req.body;
    const modelId = getRedirectedModelId(openaiRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    // 只允许 openai 类型端点
    if (model.type !== 'openai') {
      return res.status(400).json({ 
        error: 'Invalid endpoint type',
        message: `/v1/responses 接口只支持 openai 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Direct forwarding to ${model.type} endpoint: ${endpoint.base_url}`);

    // Get API key - support client x-api-key for anthropic endpoint
    let authHeader;
    try {
      const clientAuthFromXApiKey = req.headers['x-api-key']
        ? `Bearer ${req.headers['x-api-key']}`
        : null;
      authHeader = await getApiKey(req.headers.authorization || clientAuthFromXApiKey);
    } catch (error) {
      logError('Failed to get API key', error);
      return res.status(500).json({ 
        error: 'API key not available',
        message: 'Failed to get or refresh API key. Please check server logs.'
      });
    }

    const clientHeaders = req.headers;
    
    // Get provider from model config
    const provider = getModelProvider(modelId);
    
    // 获取 headers
    const headers = getOpenAIHeaders(authHeader, clientHeaders, provider);

    // 注入系统提示到 instructions 字段，并更新重定向后的模型ID
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...openaiRequest, model: modelId };
    if (systemPrompt) {
      // 如果已有 instructions，则在前面添加系统提示
      if (modifiedRequest.instructions) {
        modifiedRequest.instructions = systemPrompt + modifiedRequest.instructions;
      } else {
        // 否则直接设置系统提示
        modifiedRequest.instructions = systemPrompt;
      }
    }

    // Enforce minimum max_output_tokens (API requires >= 16)
    if (typeof modifiedRequest.max_output_tokens === 'number' && modifiedRequest.max_output_tokens < 16) {
      logInfo(`Adjusting max_output_tokens from ${modifiedRequest.max_output_tokens} to 16 (API minimum)`);
      modifiedRequest.max_output_tokens = 16;
    }

    // 处理reasoning字段
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') {
      // Auto模式：保持原始请求的reasoning字段不变
      // 如果原始请求有reasoning字段就保留，没有就不添加
    } else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
      modifiedRequest.reasoning = {
        effort: reasoningLevel,
        summary: 'auto'
      };
    } else {
      // 如果配置是off或无效，移除reasoning字段
      delete modifiedRequest.reasoning;
    }

    logRequest('POST', endpoint.base_url, headers, modifiedRequest);

    // 转发修改后的请求
    const proxyAgentInfo = getNextProxyAgent(endpoint.base_url);
    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify(modifiedRequest)
    };

    if (proxyAgentInfo?.agent) {
      fetchOptions.agent = proxyAgentInfo.agent;
    }

    const response = await fetchWithFallback(endpoint.base_url, fetchOptions, 'direct responses');

    logInfo(`Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `Endpoint returned ${response.status}`,
        details: errorText
      });
    }

    const isStreaming = openaiRequest.stream === true;

    if (isStreaming) {
      // 直接转发流式响应，不做任何转换
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        // 直接将原始响应流转发给客户端
        for await (const chunk of response.body) {
          res.write(chunk);
        }
        res.end();
        logInfo('Stream forwarded successfully');
      } catch (streamError) {
        logError('Stream error', streamError);
        res.end();
      }
    } else {
      // 直接转发非流式响应，不做任何转换
      const data = await response.json();
      logResponse(200, null, data);
      res.json(data);
    }

  } catch (error) {
    logError('Error in /v1/responses', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

// 直接转发 Anthropic 请求（不做格式转换）
async function handleDirectMessages(req, res) {
  logInfo('POST /v1/messages');

  try {
    const anthropicRequest = req.body;
    const modelId = getRedirectedModelId(anthropicRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    // 只允许 anthropic 类型端点
    if (model.type !== 'anthropic') {
      return res.status(400).json({ 
        error: 'Invalid endpoint type',
        message: `/v1/messages 接口只支持 anthropic 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Direct forwarding to ${model.type} endpoint: ${endpoint.base_url}`);

    // Get API key - support client x-api-key for anthropic endpoint
    let authHeader;
    try {
      const clientAuthFromXApiKey = req.headers['x-api-key']
        ? `Bearer ${req.headers['x-api-key']}`
        : null;
      authHeader = await getApiKey(req.headers.authorization || clientAuthFromXApiKey);
    } catch (error) {
      logError('Failed to get API key', error);
      return res.status(500).json({ 
        error: 'API key not available',
        message: 'Failed to get or refresh API key. Please check server logs.'
      });
    }

    const clientHeaders = req.headers;
    
    // Get provider from model config
    const provider = getModelProvider(modelId);
    
    // 获取 headers
    const isStreaming = anthropicRequest.stream === true;
    const headers = getAnthropicHeaders(authHeader, clientHeaders, isStreaming, modelId, provider);

    // 注入系统提示到 system 字段，并更新重定向后的模型ID
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...anthropicRequest, model: modelId };
    if (systemPrompt) {
      if (modifiedRequest.system && Array.isArray(modifiedRequest.system)) {
        // 如果已有 system 数组，则在最前面插入系统提示
        modifiedRequest.system = [
          { type: 'text', text: systemPrompt },
          ...modifiedRequest.system
        ];
      } else {
        // 否则创建新的 system 数组
        modifiedRequest.system = [
          { type: 'text', text: systemPrompt }
        ];
      }
    }

    // 处理thinking字段
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') {
      // Auto模式：保持原始请求的thinking字段不变
      // 如果原始请求有thinking字段就保留，没有就不添加
    } else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
      const budgetTokens = {
        'low': 4096,
        'medium': 12288,
        'high': 24576
      };
      
      modifiedRequest.thinking = {
        type: 'enabled',
        budget_tokens: budgetTokens[reasoningLevel]
      };
    } else {
      // 如果配置是off或无效，移除thinking字段
      delete modifiedRequest.thinking;
    }

    logRequest('POST', endpoint.base_url, headers, modifiedRequest);

    // 转发修改后的请求
    const proxyAgentInfo = getNextProxyAgent(endpoint.base_url);
    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify(modifiedRequest)
    };

    if (proxyAgentInfo?.agent) {
      fetchOptions.agent = proxyAgentInfo.agent;
    }

    const response = await fetchWithFallback(endpoint.base_url, fetchOptions, 'direct messages');

    logInfo(`Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `Endpoint returned ${response.status}`,
        details: errorText
      });
    }

    if (isStreaming) {
      // 直接转发流式响应，不做任何转换
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        // 直接将原始响应流转发给客户端
        for await (const chunk of response.body) {
          res.write(chunk);
        }
        res.end();
        logInfo('Stream forwarded successfully');
      } catch (streamError) {
        logError('Stream error', streamError);
        res.end();
      }
    } else {
      // 直接转发非流式响应，不做任何转换
      const data = await response.json();
      logResponse(200, null, data);
      res.json(data);
    }

  } catch (error) {
    logError('Error in /v1/messages', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

// 处理 Anthropic count_tokens 请求
async function handleCountTokens(req, res) {
  logInfo('POST /v1/messages/count_tokens');

  try {
    const anthropicRequest = req.body;
    const modelId = getRedirectedModelId(anthropicRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    // 只允许 anthropic 类型端点
    if (model.type !== 'anthropic') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/messages/count_tokens 接口只支持 anthropic 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
      });
    }

    const endpoint = getEndpointByType('anthropic');
    if (!endpoint) {
      return res.status(500).json({ error: 'Endpoint type anthropic not found' });
    }

    // Get API key
    let authHeader;
    try {
      const clientAuthFromXApiKey = req.headers['x-api-key']
        ? `Bearer ${req.headers['x-api-key']}`
        : null;
      authHeader = await getApiKey(req.headers.authorization || clientAuthFromXApiKey);
    } catch (error) {
      logError('Failed to get API key', error);
      return res.status(500).json({
        error: 'API key not available',
        message: 'Failed to get or refresh API key. Please check server logs.'
      });
    }

    const clientHeaders = req.headers;
    
    // Get provider from model config
    const provider = getModelProvider(modelId);
    
    const headers = getAnthropicHeaders(authHeader, clientHeaders, false, modelId, provider);

    // 构建 count_tokens 端点 URL
    const countTokensUrl = endpoint.base_url.replace('/v1/messages', '/v1/messages/count_tokens');

    // 更新请求体中的模型ID为重定向后的ID
    const modifiedRequest = { ...anthropicRequest, model: modelId };

    logInfo(`Forwarding to count_tokens endpoint: ${countTokensUrl}`);
    logRequest('POST', countTokensUrl, headers, modifiedRequest);

    const proxyAgentInfo = getNextProxyAgent(countTokensUrl);
    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify(modifiedRequest)
    };

    if (proxyAgentInfo?.agent) {
      fetchOptions.agent = proxyAgentInfo.agent;
    }

    const response = await fetchWithFallback(countTokensUrl, fetchOptions, 'count tokens');

    logInfo(`Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`Count tokens error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `Endpoint returned ${response.status}`,
        details: errorText
      });
    }

    const data = await response.json();
    logResponse(200, null, data);
    res.json(data);

  } catch (error) {
    logError('Error in /v1/messages/count_tokens', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

// 注册路由
router.post('/v1/chat/completions', handleChatCompletions);
router.post('/v1/responses', handleDirectResponses);
router.post('/v1/messages', handleDirectMessages);
router.post('/v1/messages/count_tokens', handleCountTokens);

export default router;
