/**
 * Key Checker Module - Standalone utility to check Factory API key status
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

// Test endpoint URL (using Anthropic messages endpoint for minimal test)
const TEST_URL = 'https://api.factory.ai/api/llm/a/v1/messages';
// Usage endpoint (Factory API usage info)
const USAGE_URL = 'https://api.factory.ai/api/usage';

/**
 * Serve the key checker HTML page
 */
router.get('/key-checker', (req, res) => {
  res.sendFile(path.join(__dirname, 'key-checker.html'));
});

/**
 * Extract usage-related headers from response
 */
function extractUsageHeaders(headers) {
  const usageInfo = {};
  const headerPrefixes = ['x-ratelimit', 'x-usage', 'x-quota', 'x-tokens', 'ratelimit'];
  
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (headerPrefixes.some(prefix => lowerKey.includes(prefix))) {
      usageInfo[key] = value;
    }
  });
  
  return Object.keys(usageInfo).length > 0 ? usageInfo : null;
}

/**
 * Try to get usage information from Factory API
 */
async function tryGetUsage(apiKey, proxyAgentInfo) {
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
    
    const response = await fetch(USAGE_URL, fetchOptions);
    
    if (response.ok) {
      const data = await response.json();
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * API endpoint to check if a key is valid
 */
router.post('/check-key', async (req, res) => {
  const { apiKey } = req.body;

  if (!apiKey || typeof apiKey !== 'string') {
    return res.json({
      status: 'error',
      error: 'No API key provided'
    });
  }

  const keyPreview = apiKey.substring(0, 15) + '...';

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
    
    // Extract any usage-related headers
    const usageHeaders = extractUsageHeaders(response.headers);

    // Determine key status based on response
    if (statusCode === 200) {
      // Parse response to get usage info if available
      const responseData = await response.json();
      const usage = responseData.usage || null;
      
      // Try to get additional usage info from usage endpoint
      const usageInfo = await tryGetUsage(apiKey, proxyAgentInfo);
      
      return res.json({
        status: 'active',
        statusCode,
        keyPreview,
        model: 'claude-sonnet-4-5-20250929',
        usage,
        usageHeaders,
        usageInfo
      });
    } else if (statusCode === 429) {
      // Quota exceeded
      return res.json({
        status: 'quota_exceeded',
        statusCode,
        keyPreview,
        error: 'Rate limit or quota exceeded',
        usageHeaders
      });
    } else if (statusCode === 401 || statusCode === 403) {
      // Invalid or deactivated key
      return res.json({
        status: 'invalid',
        statusCode,
        keyPreview
      });
    } else if (statusCode === 402) {
      // Payment required
      return res.json({
        status: 'quota_exceeded',
        statusCode,
        keyPreview,
        error: 'Payment required - billing issue',
        usageHeaders
      });
    } else {
      // Other status
      const errorText = await response.text();
      return res.json({
        status: 'unknown',
        statusCode,
        keyPreview,
        error: errorText.substring(0, 200)
      });
    }

  } catch (error) {
    return res.json({
      status: 'error',
      keyPreview,
      error: error.message
    });
  }
});

export default router;
