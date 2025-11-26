import fs from 'fs';
import path from 'path';
import os from 'os';
import fetch from 'node-fetch';
import { logDebug, logError, logInfo } from './logger.js';
import { getNextProxyAgent } from './proxy-manager.js';

// State management for API key and refresh
let currentApiKey = null;
let currentRefreshToken = null;
let lastRefreshTime = null;
let clientId = null;
let authSource = null; // 'env' or 'file' or 'factory_key' or 'client'
let authFilePath = null;
let factoryApiKeys = []; // Array of Factory API keys for fallback support
let currentKeyIndex = 0; // Track which key is currently active
let startingKeyIndex = 0; // Track where we started in current rotation cycle
let hasCompletedFullCycle = false; // Track if we've tried all keys in current cycle

const REFRESH_URL = 'https://api.workos.com/user_management/authenticate';
const REFRESH_INTERVAL_HOURS = 6; // Refresh every 6 hours
const TOKEN_VALID_HOURS = 8; // Token valid for 8 hours

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 * Format: 26 characters using Crockford's Base32
 * First 10 chars: timestamp (48 bits)
 * Last 16 chars: random (80 bits)
 */
function generateULID() {
  // Crockford's Base32 alphabet (no I, L, O, U to avoid confusion)
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  
  // Get timestamp in milliseconds
  const timestamp = Date.now();
  
  // Encode timestamp to 10 characters
  let time = '';
  let ts = timestamp;
  for (let i = 9; i >= 0; i--) {
    const mod = ts % 32;
    time = ENCODING[mod] + time;
    ts = Math.floor(ts / 32);
  }
  
  // Generate 16 random characters
  let randomPart = '';
  for (let i = 0; i < 16; i++) {
    const rand = Math.floor(Math.random() * 32);
    randomPart += ENCODING[rand];
  }
  
  return time + randomPart;
}

/**
 * Generate a client ID in format: client_01{ULID}
 */
function generateClientId() {
  const ulid = generateULID();
  return `client_01${ulid}`;
}

/**
 * Load auth configuration with priority system
 * Priority: FACTORY_API_KEY > refresh token mechanism > client authorization
 */
function loadAuthConfig() {
  // 1. Check FACTORY_API_KEY environment variables (highest priority)
  // Support FACTORY_API_KEY through FACTORY_API_KEY_7 for fallback (up to 7 keys)
  const keyEnvNames = [
    'FACTORY_API_KEY',
    'FACTORY_API_KEY_2',
    'FACTORY_API_KEY_3',
    'FACTORY_API_KEY_4',
    'FACTORY_API_KEY_5',
    'FACTORY_API_KEY_6',
    'FACTORY_API_KEY_7'
  ];

  for (const envName of keyEnvNames) {
    const keyValue = process.env[envName];
    if (keyValue && keyValue.trim() !== '') {
      factoryApiKeys.push(keyValue.trim());
    }
  }

  if (factoryApiKeys.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log('✅ FACTORY API KEYS LOADED SUCCESSFULLY');
    console.log('='.repeat(80));
    console.log(`Total keys loaded: ${factoryApiKeys.length}/7`);
    console.log('Keys will be used as fallback one after another on quota/auth errors');
    console.log('-'.repeat(80));
    factoryApiKeys.forEach((key, index) => {
      const envName = index === 0 ? 'FACTORY_API_KEY' : `FACTORY_API_KEY_${index + 1}`;
      console.log(`  Key #${index + 1}: ${envName} (${key.substring(0, 15)}...)`);
    });
    console.log('='.repeat(80) + '\n');

    logInfo(`Loaded ${factoryApiKeys.length} Factory API key(s) for fallback support`);
    authSource = 'factory_key';
    currentKeyIndex = 0;
    return { type: 'factory_key', value: factoryApiKeys };
  }

  // 2. Check refresh token mechanism (DROID_REFRESH_KEY)
  const envRefreshKey = process.env.DROID_REFRESH_KEY;
  if (envRefreshKey && envRefreshKey.trim() !== '') {
    logInfo('Using refresh token from DROID_REFRESH_KEY environment variable');
    authSource = 'env';
    authFilePath = path.join(process.cwd(), 'auth.json');
    return { type: 'refresh', value: envRefreshKey.trim() };
  }

  // 3. Check ~/.factory/auth.json
  const homeDir = os.homedir();
  const factoryAuthPath = path.join(homeDir, '.factory', 'auth.json');
  
  try {
    if (fs.existsSync(factoryAuthPath)) {
      const authContent = fs.readFileSync(factoryAuthPath, 'utf-8');
      const authData = JSON.parse(authContent);
      
      if (authData.refresh_token && authData.refresh_token.trim() !== '') {
        logInfo('Using refresh token from ~/.factory/auth.json');
        authSource = 'file';
        authFilePath = factoryAuthPath;
        
        // Also load access_token if available
        if (authData.access_token) {
          currentApiKey = authData.access_token.trim();
        }
        
        return { type: 'refresh', value: authData.refresh_token.trim() };
      }
    }
  } catch (error) {
    logError('Error reading ~/.factory/auth.json', error);
  }

  // 4. No configured auth found - will use client authorization
  logInfo('No auth configuration found, will use client authorization headers');
  authSource = 'client';
  return { type: 'client', value: null };
}

/**
 * Refresh API key using refresh token
 */
async function refreshApiKey() {
  if (!currentRefreshToken) {
    throw new Error('No refresh token available');
  }

  if (!clientId) {
    clientId = 'client_01HNM792M5G5G1A2THWPXKFMXB';
    logDebug(`Using fixed client ID: ${clientId}`);
  }

  logInfo('Refreshing API key...');

  try {
    // Create form data
    const formData = new URLSearchParams();
    formData.append('grant_type', 'refresh_token');
    formData.append('refresh_token', currentRefreshToken);
    formData.append('client_id', clientId);

    const proxyAgentInfo = getNextProxyAgent(REFRESH_URL);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    };

    if (proxyAgentInfo?.agent) {
      fetchOptions.agent = proxyAgentInfo.agent;
    }

    const response = await fetch(REFRESH_URL, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    
    // Update tokens
    currentApiKey = data.access_token;
    currentRefreshToken = data.refresh_token;
    lastRefreshTime = Date.now();

    // Log user info
    if (data.user) {
      logInfo(`Authenticated as: ${data.user.email} (${data.user.first_name} ${data.user.last_name})`);
      logInfo(`User ID: ${data.user.id}`);
      logInfo(`Organization ID: ${data.organization_id}`);
    }

    // Save tokens to file
    saveTokens(data.access_token, data.refresh_token);

    logInfo(`New Refresh-Key: ${currentRefreshToken}`);
    logInfo('API key refreshed successfully');
    return data.access_token;

  } catch (error) {
    logError('Failed to refresh API key', error);
    throw error;
  }
}

/**
 * Save tokens to appropriate file
 */
function saveTokens(accessToken, refreshToken) {
  try {
    const authData = {
      access_token: accessToken,
      refresh_token: refreshToken,
      last_updated: new Date().toISOString()
    };

    // Ensure directory exists
    const dir = path.dirname(authFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // If saving to ~/.factory/auth.json, preserve other fields
    if (authSource === 'file' && fs.existsSync(authFilePath)) {
      try {
        const existingData = JSON.parse(fs.readFileSync(authFilePath, 'utf-8'));
        Object.assign(authData, existingData, {
          access_token: accessToken,
          refresh_token: refreshToken,
          last_updated: authData.last_updated
        });
      } catch (error) {
        logError('Error reading existing auth file, will overwrite', error);
      }
    }

    fs.writeFileSync(authFilePath, JSON.stringify(authData, null, 2), 'utf-8');
    logDebug(`Tokens saved to ${authFilePath}`);

  } catch (error) {
    logError('Failed to save tokens', error);
  }
}

/**
 * Check if API key needs refresh (older than 6 hours)
 */
function shouldRefresh() {
  if (!lastRefreshTime) {
    return true;
  }

  const hoursSinceRefresh = (Date.now() - lastRefreshTime) / (1000 * 60 * 60);
  return hoursSinceRefresh >= REFRESH_INTERVAL_HOURS;
}

/**
 * Initialize auth system - load auth config and setup initial API key if needed
 */
export async function initializeAuth() {
  try {
    const authConfig = loadAuthConfig();
    
    if (authConfig.type === 'factory_key') {
      // Using fixed FACTORY_API_KEY, no refresh needed
      logInfo('Auth system initialized with fixed API key');
    } else if (authConfig.type === 'refresh') {
      // Using refresh token mechanism
      currentRefreshToken = authConfig.value;
      
      // Always refresh on startup to get fresh token
      await refreshApiKey();
      logInfo('Auth system initialized with refresh token mechanism');
    } else {
      // Using client authorization, no setup needed
      logInfo('Auth system initialized for client authorization mode');
    }
    
    logInfo('Auth system initialized successfully');
  } catch (error) {
    logError('Failed to initialize auth system', error);
    throw error;
  }
}

/**
 * Get API key based on configured authorization method
 * @param {string} clientAuthorization - Authorization header from client request (optional)
 */
export async function getApiKey(clientAuthorization = null) {
  // Priority 1: FACTORY_API_KEY environment variable(s)
  if (authSource === 'factory_key' && factoryApiKeys.length > 0) {
    const currentKey = factoryApiKeys[currentKeyIndex];
    logDebug(`Using Factory API key #${currentKeyIndex + 1} (${currentKey.substring(0, 10)}...)`);
    return `Bearer ${currentKey}`;
  }

  // Priority 2: Refresh token mechanism
  if (authSource === 'env' || authSource === 'file') {
    // Check if we need to refresh
    if (shouldRefresh()) {
      logInfo('API key needs refresh (6+ hours old)');
      await refreshApiKey();
    }

    if (!currentApiKey) {
      throw new Error('No API key available from refresh token mechanism.');
    }

    return `Bearer ${currentApiKey}`;
  }

  // Priority 3: Client authorization header
  if (clientAuthorization) {
    logDebug('Using client authorization header');
    return clientAuthorization;
  }

  // No authorization available
  throw new Error('No authorization available. Please configure FACTORY_API_KEY, refresh token, or provide client authorization.');
}

/**
 * Rotate to next available Factory API key
 * Returns true if rotation was successful, false if no more keys available
 */
export function rotateFactoryApiKey() {
  if (authSource !== 'factory_key' || factoryApiKeys.length <= 1) {
    return false;
  }

  const oldIndex = currentKeyIndex;
  const nextIndex = (currentKeyIndex + 1) % factoryApiKeys.length;

  // Check if we've completed a full cycle (back to starting key)
  if (nextIndex === startingKeyIndex) {
    hasCompletedFullCycle = true;
    logInfo('Completed full cycle through all Factory API keys');
    return false;
  }

  currentKeyIndex = nextIndex;

  console.log('\n' + '='.repeat(80));
  console.log('🔄 FACTORY API KEY ROTATION');
  console.log('='.repeat(80));
  console.log(`Previous key: #${oldIndex + 1} (${factoryApiKeys[oldIndex].substring(0, 10)}...)`);
  console.log(`New active key: #${currentKeyIndex + 1} (${factoryApiKeys[currentKeyIndex].substring(0, 10)}...)`);
  console.log(`Reason: Previous key failed (quota exceeded or authentication error)`);
  console.log('='.repeat(80) + '\n');

  logInfo(`Rotated to Factory API key #${currentKeyIndex + 1}`);
  return true;
}

/**
 * Check if we have more Factory API keys available for fallback
 */
export function hasMoreFactoryKeys() {
  if (authSource !== 'factory_key' || factoryApiKeys.length <= 1) {
    return false;
  }
  // Return false if we've already tried all keys in this cycle
  return !hasCompletedFullCycle;
}

/**
 * Start a new rotation cycle (call this at the beginning of each request)
 */
export function startNewRotationCycle() {
  startingKeyIndex = currentKeyIndex;
  hasCompletedFullCycle = false;
}

/**
 * Get current Factory API key info for logging
 */
export function getCurrentKeyInfo() {
  if (authSource === 'factory_key' && factoryApiKeys.length > 0) {
    return {
      index: currentKeyIndex + 1,
      total: factoryApiKeys.length,
      preview: factoryApiKeys[currentKeyIndex].substring(0, 10) + '...'
    };
  }
  return null;
}
