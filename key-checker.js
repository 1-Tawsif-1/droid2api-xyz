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

/**
 * Serve the key checker HTML page
 */
router.get('/key-checker', (req, res) => {
  res.sendFile(path.join(__dirname, 'key-checker.html'));
});

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

    // Determine key status based on response
    if (statusCode === 200) {
      // Key is valid and working
      return res.json({
        status: 'active',
        statusCode,
        keyPreview,
        model: 'claude-sonnet-4-5-20250929'
      });
    } else if (statusCode === 429) {
      // Quota exceeded
      return res.json({
        status: 'quota_exceeded',
        statusCode,
        keyPreview,
        error: 'Rate limit or quota exceeded'
      });
    } else if (statusCode === 401 || statusCode === 403) {
      // Invalid or deactivated key
      const errorText = await response.text();
      return res.json({
        status: 'invalid',
        statusCode,
        keyPreview,
        error: errorText.substring(0, 200)
      });
    } else if (statusCode === 402) {
      // Payment required
      return res.json({
        status: 'quota_exceeded',
        statusCode,
        keyPreview,
        error: 'Payment required - billing issue'
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
