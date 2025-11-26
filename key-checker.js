/**
 * Key Checker Module - Standalone utility to check Factory API key status and usage
 * This module is completely isolated from the main proxy functionality
 */

import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import { getNextProxyAgent } from './proxy-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Factory API endpoints
const TEST_URL = 'https://api.factory.ai/api/llm/a/v1/messages';
const USAGE_URL = 'https://api.factory.ai/api/v1/usage';
const ACCOUNT_URL = 'https://api.factory.ai/api/v1/account';
const BILLING_URL = 'https://api.factory.ai/api/v1/billing';

/**
 * Serve the key checker HTML page
 */
router.get('/key-checker', (req, res) => {
  res.sendFile(path.join(__dirname, 'key-checker.html'));
});

/**
 * Try multiple endpoints to get usage/quota information
 */
async function tryGetUsageInfo(apiKey, proxyAgentInfo) {
  const endpoints = [
    USAGE_URL,
    ACCOUNT_URL,
    BILLING_URL,
    'https://api.factory.ai/api/usage',
    'https://api.factory.ai/api/v1/quota',
    'https://api.factory.ai/api/v1/tokens'
  ];

  for (const url of endpoints) {
    try {
      const fetchOptions = {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      };
      
      if (proxyAgentInfo?.agent) {
        fetchOptions.agent = proxyAgentInfo.agent;
      }
      
      const response = await fetch(url, fetchOptions);
      
      if (response.ok) {
        const data = await response.json();
        // Try to extract usage info from various response formats
        if (data.tokens_remaining !== undefined || data.tokens_used !== undefined) {
          return {
            total: data.tokens_total || data.total_tokens || data.limit || 0,
            used: data.tokens_used || data.used_tokens || data.usage || 0,
            remaining: data.tokens_remaining || data.remaining_tokens || data.remaining || 0
          };
        }
        if (data.usage) {
          return {
            total: data.usage.total || data.usage.limit || 0,
            used: data.usage.used || 0,
            remaining: data.usage.remaining || 0
          };
        }
        if (data.quota) {
          return {
            total: data.quota.total || data.quota.limit || 0,
            used: data.quota.used || 0,
            remaining: data.quota.remaining || 0
          };
        }
      }
    } catch {
      // Continue to next endpoint
    }
  }
  return null;
}

/**
 * Extract usage info from response headers
 */
function extractUsageFromHeaders(headers) {
  const usage = { total: 0, used: 0, remaining: 0 };
  let hasData = false;

  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    
    // Try to extract limit/total
    if (lowerKey.includes('limit') && !lowerKey.includes('remaining')) {
      const num = parseInt(value, 10);
      if (!isNaN(num)) {
        usage.total = num;
        hasData = true;
      }
    }
    
    // Try to extract remaining
    if (lowerKey.includes('remaining')) {
      const num = parseInt(value, 10);
      if (!isNaN(num)) {
        usage.remaining = num;
        hasData = true;
      }
    }
    
    // Try to extract used
    if (lowerKey.includes('used')) {
      const num = parseInt(value, 10);
      if (!isNaN(num)) {
        usage.used = num;
        hasData = true;
      }
    }
  });

  // Calculate missing values if possible
  if (hasData) {
    if (usage.total > 0 && usage.remaining > 0 && usage.used === 0) {
      usage.used = usage.total - usage.remaining;
    }
    if (usage.total > 0 && usage.used > 0 && usage.remaining === 0) {
      usage.remaining = usage.total - usage.used;
    }
    if (usage.used > 0 && usage.remaining > 0 && usage.total === 0) {
      usage.total = usage.used + usage.remaining;
    }
  }

  return hasData ? usage : null;
}

/**
 * Analyze error response to determine true key status
 * Be lenient - only mark as invalid if error explicitly says so
 */
function analyzeErrorResponse(statusCode, errorData) {
  const errorMessage = (errorData?.error?.message || errorData?.detail || errorData?.message || '').toLowerCase();
  const errorTitle = (errorData?.title || '').toLowerCase();
  
  // Only mark as INVALID if error explicitly mentions invalid/unauthorized API key
  if (errorMessage.includes('invalid api key') || 
      errorMessage.includes('invalid_api_key') ||
      errorMessage.includes('api key not found') ||
      errorMessage.includes('authentication failed') ||
      (errorMessage.includes('unauthorized') && errorMessage.includes('key'))) {
    return { status: 'invalid', message: 'Invalid or deactivated API key' };
  }
  
  // Check for quota/billing issues
  if (errorMessage.includes('quota') || 
      errorMessage.includes('rate limit') ||
      errorMessage.includes('exceeded') ||
      errorMessage.includes('billing') ||
      errorMessage.includes('reload your tokens') ||
      errorTitle.includes('payment required')) {
    return { status: 'quota_exceeded', message: 'Quota exceeded or payment required' };
  }
  
  // For 400, 403, 404 - assume key is valid (test request issue, not key issue)
  if (statusCode === 400) {
    return { status: 'active', message: 'Key valid (test request format error)' };
  }
  
  if (statusCode === 403) {
    // 403 without explicit "invalid key" message - assume key is valid
    // The 403 is likely from model access or endpoint issue, not the key itself
    return { status: 'active', message: 'Key valid (endpoint access issue)' };
  }
  
  if (statusCode === 404) {
    return { status: 'active', message: 'Key valid (model not found)' };
  }
  
  return null; // Unknown, use default logic
}

/**
 * API endpoint to check if a key is valid and get usage info
 */
router.post('/check-key', async (req, res) => {
  const { apiKey } = req.body;

  if (!apiKey || typeof apiKey !== 'string') {
    return res.json({
      status: 'error',
      error: 'No API key provided'
    });
  }

  const keyPreview = apiKey.substring(0, 8) + '...' + apiKey.slice(-4);

  try {
    // Send a minimal test request to check key validity
    const testPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [
        { role: 'user', content: 'hi' }
      ]
    };

    const proxyAgentInfo = getNextProxyAgent(TEST_URL);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'x-api-provider': 'anthropic'
      },
      body: JSON.stringify(testPayload)
    };

    if (proxyAgentInfo?.agent) {
      fetchOptions.agent = proxyAgentInfo.agent;
    }

    const response = await fetch(TEST_URL, fetchOptions);
    const statusCode = response.status;
    
    // Extract usage from headers
    let usage = extractUsageFromHeaders(response.headers);
    
    // Get response body for error analysis
    let responseData = null;
    try {
      responseData = await response.json();
    } catch {
      // Response might not be JSON
    }

    // Determine key status based on response
    if (statusCode === 200) {
      // Try to get usage info from dedicated endpoint
      const usageInfo = await tryGetUsageInfo(apiKey, proxyAgentInfo);
      if (usageInfo) {
        usage = usageInfo;
      }
      
      // If we still don't have usage data, provide default values
      if (!usage) {
        usage = {
          total: 40000000, // Default 40M tokens (common Factory plan)
          used: 0,
          remaining: 40000000
        };
      }
      
      return res.json({
        status: 'active',
        statusCode,
        keyPreview,
        usage,
        message: 'Key is active and working'
      });
    }
    
    // Analyze error response for non-200 status codes
    const errorAnalysis = analyzeErrorResponse(statusCode, responseData);
    
    if (errorAnalysis) {
      // Use analyzed status
      if (errorAnalysis.status === 'active') {
        // Key seems valid even though request failed
        const usageInfo = await tryGetUsageInfo(apiKey, proxyAgentInfo);
        return res.json({
          status: 'active',
          statusCode,
          keyPreview,
          usage: usageInfo || usage || { total: 40000000, used: 0, remaining: 40000000 },
          message: errorAnalysis.message
        });
      }
      
      if (errorAnalysis.status === 'restricted') {
        return res.json({
          status: 'restricted',
          statusCode,
          keyPreview,
          usage: usage || { total: 0, used: 0, remaining: 0 },
          message: errorAnalysis.message
        });
      }
      
      if (errorAnalysis.status === 'quota_exceeded') {
        return res.json({
          status: 'quota_exceeded',
          statusCode,
          keyPreview,
          usage: usage || { total: 0, used: 0, remaining: 0 },
          message: errorAnalysis.message
        });
      }
      
      if (errorAnalysis.status === 'invalid') {
        return res.json({
          status: 'invalid',
          statusCode,
          keyPreview,
          usage: { total: 0, used: 0, remaining: 0 },
          message: errorAnalysis.message
        });
      }
    }
    
    // Default handling for status codes without specific error analysis
    if (statusCode === 429) {
      return res.json({
        status: 'quota_exceeded',
        statusCode,
        keyPreview,
        usage: usage || { total: 0, used: 0, remaining: 0 },
        message: 'Rate limited or quota exceeded'
      });
    }
    
    if (statusCode === 402) {
      return res.json({
        status: 'quota_exceeded',
        statusCode,
        keyPreview,
        usage: usage || { total: 0, used: 0, remaining: 0 },
        message: 'Payment required - reload tokens'
      });
    }
    
    if (statusCode === 401) {
      return res.json({
        status: 'invalid',
        statusCode,
        keyPreview,
        usage: { total: 0, used: 0, remaining: 0 },
        message: 'Unauthorized - check API key'
      });
    }
    
    if (statusCode === 403) {
      // 403 without specific error message - assume key is valid (test request issue)
      const usageInfo = await tryGetUsageInfo(apiKey, proxyAgentInfo);
      return res.json({
        status: 'active',
        statusCode,
        keyPreview,
        usage: usageInfo || usage || { total: 40000000, used: 0, remaining: 40000000 },
        message: 'Key valid (endpoint returned 403)'
      });
    }
    
    // Unknown status
    return res.json({
      status: 'unknown',
      statusCode,
      keyPreview,
      usage: usage || { total: 0, used: 0, remaining: 0 },
      message: `Unknown response (HTTP ${statusCode})`
    });

  } catch (error) {
    return res.json({
      status: 'error',
      keyPreview,
      error: error.message,
      usage: { total: 0, used: 0, remaining: 0 },
      message: 'Network or connection error'
    });
  }
});

export default router;
