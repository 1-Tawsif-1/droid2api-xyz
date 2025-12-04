import { isDevMode } from './config.js';

// Debug filter: only log for specific models (null = log all)
const DEBUG_MODEL_FILTER = ['gpt-5.1-codex'];

// Current request context
let currentModel = null;

export function setCurrentModel(model) {
  currentModel = model;
}

function shouldLog() {
  if (!isDevMode()) return false;
  if (!DEBUG_MODEL_FILTER || DEBUG_MODEL_FILTER.length === 0) return true;
  return currentModel && DEBUG_MODEL_FILTER.includes(currentModel);
}

export function logInfo(message, data = null) {
  // Skip info logs in dev mode unless model matches filter
  if (isDevMode() && !shouldLog()) return;
  console.log(`[INFO] ${message}`);
  if (data && shouldLog()) {
    console.log(JSON.stringify(data, null, 2));
  }
}

export function logDebug(message, data = null) {
  if (!shouldLog()) return;
  console.log(`[DEBUG] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

export function logError(message, error = null) {
  // Always log errors
  console.error(`[ERROR] ${message}`);
  if (error) {
    if (isDevMode()) {
      console.error(error);
    } else {
      console.error(error.message || error);
    }
  }
}

export function logRequest(method, url, headers = null, body = null) {
  if (!shouldLog()) return;
  console.log(`\n${'='.repeat(80)}`);
  console.log(`[REQUEST] ${method} ${url}`);
  if (headers) {
    console.log('[HEADERS]', JSON.stringify(headers, null, 2));
  }
  if (body) {
    console.log('[BODY]', JSON.stringify(body, null, 2));
  }
  console.log('='.repeat(80) + '\n');
}

export function logResponse(status, headers = null, body = null) {
  if (!shouldLog()) return;
  console.log(`\n${'-'.repeat(80)}`);
  console.log(`[RESPONSE] Status: ${status}`);
  if (headers) {
    console.log('[HEADERS]', JSON.stringify(headers, null, 2));
  }
  if (body) {
    console.log('[BODY]', JSON.stringify(body, null, 2));
  }
  console.log('-'.repeat(80) + '\n');
}
