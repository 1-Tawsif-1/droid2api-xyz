import express from 'express';
import { loadConfig, isDevMode, getPort } from './config.js';
import { logInfo, logError } from './logger.js';
import router from './routes.js';
import keyCheckerRouter from './key-checker.js';
import { initializeAuth } from './auth.js';
import { initializeUserAgentUpdater } from './user-agent-updater.js';

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, anthropic-version');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Key checker utility (isolated from main functionality)
app.use(keyCheckerRouter);

app.use(router);

app.get('/', (req, res) => {
  res.json({
    name: 'droid2api',
    version: '1.0.0',
    description: 'OpenAI Compatible API Proxy',
    endpoints: [
      'GET /health',
      'GET /ping',
      'GET /key-checker',
      'GET /v1/models',
      'POST /v1/chat/completions',
      'POST /v1/responses',
      'POST /v1/messages',
      'POST /v1/messages/count_tokens'
    ]
  });
});

// Health check endpoint for Uptime Robot
app.get('/health', (req, res) => {
  const timestamp = new Date().toISOString();
  const userAgent = req.headers['user-agent'] || 'Unknown';

  console.log('\n' + '='.repeat(80));
  console.log('✅ Health Check Ping Received');
  console.log('='.repeat(80));
  console.log(`Timestamp: ${timestamp}`);
  console.log(`User-Agent: ${userAgent}`);
  console.log(`IP Address: ${req.ip || req.connection.remoteAddress}`);
  console.log('='.repeat(80) + '\n');

  logInfo('Health check endpoint pinged', {
    timestamp,
    userAgent,
    ip: req.ip || req.connection.remoteAddress
  });

  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: timestamp,
    service: 'droid2api'
  });
});

// Alternative ping endpoint (commonly used by monitoring services)
app.get('/ping', (req, res) => {
  const timestamp = new Date().toISOString();

  console.log('\n' + '='.repeat(80));
  console.log('🏓 Ping Received');
  console.log('='.repeat(80));
  console.log(`Timestamp: ${timestamp}`);
  console.log(`IP Address: ${req.ip || req.connection.remoteAddress}`);
  console.log('='.repeat(80) + '\n');

  logInfo('Ping endpoint accessed');

  res.status(200).send('pong');
});

// 404 处理 - 捕获所有未匹配的路由
app.use((req, res, next) => {
  const errorInfo = {
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.path,
    query: req.query,
    params: req.params,
    body: req.body,
    headers: {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent'],
      'origin': req.headers['origin'],
      'referer': req.headers['referer']
    },
    ip: req.ip || req.connection.remoteAddress
  };

  console.error('\n' + '='.repeat(80));
  console.error('❌ 非法请求地址');
  console.error('='.repeat(80));
  console.error(`时间: ${errorInfo.timestamp}`);
  console.error(`方法: ${errorInfo.method}`);
  console.error(`地址: ${errorInfo.url}`);
  console.error(`路径: ${errorInfo.path}`);
  
  if (Object.keys(errorInfo.query).length > 0) {
    console.error(`查询参数: ${JSON.stringify(errorInfo.query, null, 2)}`);
  }
  
  if (errorInfo.body && Object.keys(errorInfo.body).length > 0) {
    console.error(`请求体: ${JSON.stringify(errorInfo.body, null, 2)}`);
  }
  
  console.error(`客户端IP: ${errorInfo.ip}`);
  console.error(`User-Agent: ${errorInfo.headers['user-agent'] || 'N/A'}`);
  
  if (errorInfo.headers.referer) {
    console.error(`来源: ${errorInfo.headers.referer}`);
  }
  
  console.error('='.repeat(80) + '\n');

  logError('Invalid request path', errorInfo);

  res.status(404).json({
    error: 'Not Found',
    message: `路径 ${req.method} ${req.path} 不存在`,
    timestamp: errorInfo.timestamp,
    availableEndpoints: [
      'GET /v1/models',
      'POST /v1/chat/completions',
      'POST /v1/responses',
      'POST /v1/messages',
      'POST /v1/messages/count_tokens'
    ]
  });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  logError('Unhandled error', err);
  res.status(500).json({
    error: 'Internal server error',
    message: isDevMode() ? err.message : undefined
  });
});

(async () => {
  try {
    loadConfig();
    logInfo('Configuration loaded successfully');
    logInfo(`Dev mode: ${isDevMode()}`);
    
    // Initialize User-Agent version updater
    initializeUserAgentUpdater();
    
    // Initialize auth system (load and setup API key if needed)
    // This won't throw error if no auth config is found - will use client auth
    await initializeAuth();
    
    const PORT = getPort();
  const HOST = '0.0.0.0'; // Bind to all interfaces for cloud deployment
  logInfo(`Starting server on ${HOST}:${PORT}...`);

  const server = app.listen(PORT, HOST)
    .on('listening', () => {
      logInfo(`Server running on http://${HOST}:${PORT}`);
      logInfo('Available endpoints:');
      logInfo('  GET  /health (Uptime monitoring)');
      logInfo('  GET  /ping (Uptime monitoring)');
      logInfo('  GET  /key-checker (API Key validator)');
      logInfo('  GET  /v1/models');
      logInfo('  POST /v1/chat/completions');
      logInfo('  POST /v1/responses');
      logInfo('  POST /v1/messages');
      logInfo('  POST /v1/messages/count_tokens');
    })
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n${'='.repeat(80)}`);
        console.error(`ERROR: Port ${PORT} is already in use!`);
        console.error('');
        console.error('Please choose one of the following options:');
        console.error(`  1. Stop the process using port ${PORT}:`);
        console.error(`     lsof -ti:${PORT} | xargs kill`);
        console.error('');
        console.error('  2. Change the port in config.json:');
        console.error('     Edit config.json and modify the "port" field');
        console.error(`${'='.repeat(80)}\n`);
        process.exit(1);
      } else {
        logError('Failed to start server', err);
        process.exit(1);
      }
    });
  } catch (error) {
    logError('Failed to start server', error);
    process.exit(1);
  }
})();
