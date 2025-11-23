import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo } from './logger.js';
import { getCurrentUserAgent } from './user-agent-updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let config = null;

export function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configData);
    return config;
  } catch (error) {
    throw new Error(`Failed to load config.json: ${error.message}`);
  }
}

export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

export function getModelById(modelId) {
  const cfg = getConfig();
  return cfg.models.find(m => m.id === modelId);
}

export function getEndpointByType(type) {
  const cfg = getConfig();
  return cfg.endpoint.find(e => e.name === type);
}

export function isDevMode() {
  const cfg = getConfig();
  return cfg.dev_mode === true;
}

export function getPort() {
  // Prioritize environment variable (used by Render and other cloud platforms)
  if (process.env.PORT) {
    const envPort = parseInt(process.env.PORT, 10);
    console.log(`[PORT] Using PORT from environment variable: ${envPort}`);
    return envPort;
  }
  const cfg = getConfig();
  const configPort = cfg.port || 3000;
  console.log(`[PORT] Using port from config: ${configPort}`);
  return configPort;
}

export function getSystemPrompt() {
  const cfg = getConfig();
  return cfg.system_prompt || '';
}

export function getModelReasoning(modelId) {
  const model = getModelById(modelId);
  if (!model || !model.reasoning) {
    return null;
  }
  const reasoningLevel = model.reasoning.toLowerCase();
  if (['low', 'medium', 'high', 'auto'].includes(reasoningLevel)) {
    return reasoningLevel;
  }
  return null;
}

export function getModelProvider(modelId) {
  const model = getModelById(modelId);
  return model?.provider || null;
}

export function getUserAgent() {
  return getCurrentUserAgent();
}

export function getProxyConfigs() {
  const cfg = getConfig();
  if (!Array.isArray(cfg.proxies)) {
    return [];
  }
  return cfg.proxies.filter(proxy => proxy && typeof proxy === 'object');
}

export function getRedirectedModelId(modelId) {
  const cfg = getConfig();
  if (cfg.model_redirects && cfg.model_redirects[modelId]) {
    const redirectedId = cfg.model_redirects[modelId];
    console.log(`[REDIRECT] Model redirected: ${modelId} -> ${redirectedId}`);
    logInfo(`Model redirected: ${modelId} -> ${redirectedId}`);
    return redirectedId;
  }
  return modelId;
}
