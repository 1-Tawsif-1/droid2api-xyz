# Codebase Index - droid2api

## 📋 Project Overview

**Name:** droid2api  
**Version:** 1.3.7  
**Description:** OpenAI Compatible API Proxy  
**Type:** Node.js ES Module (type: "module")  
**License:** MIT  

This is an API proxy server that provides OpenAI-compatible endpoints for accessing various LLM models (OpenAI, Anthropic, and others) through a unified interface.

---

## 🏗️ Architecture

### Core Components

```
droid2api/
├── server.js              # Main application entry point
├── routes.js              # API route handlers and request processing
├── config.js              # Configuration management
├── auth.js                # Authentication and token management
├── proxy-manager.js       # Proxy server management
├── logger.js              # Logging utilities
├── user-agent-updater.js  # User-Agent version auto-updater
└── transformers/          # Request/response transformers
    ├── request-anthropic.js
    ├── request-openai.js
    ├── request-common.js
    ├── response-anthropic.js
    └── response-openai.js
```

---

## 📁 File Descriptions

### **server.js** - Main Application Entry
- Initializes Express.js server
- Sets up middleware for JSON parsing and CORS
- Loads configuration and authentication
- Initializes user-agent updater
- Starts HTTP server on configured/environment port
- Handles graceful shutdown

**Key Functions:**
- Application bootstrap and initialization
- Server lifecycle management

---

### **routes.js** - API Route Handlers
- Implements OpenAI-compatible API endpoints
- Handles request routing and transformation
- Manages streaming and non-streaming responses
- Processes model-specific requests

**Key Endpoints:**
- `GET /` - Health check
- `GET /v1/models` - List available models
- `POST /v1/chat/completions` - OpenAI-compatible chat endpoint
- `POST /v1/responses` - Direct OpenAI format proxy
- `POST /v1/messages` - Direct Anthropic format proxy

**Key Features:**
- Model redirect handling
- Provider-specific request transformation
- Streaming response handling
- Error handling and logging

---

### **config.js** - Configuration Management
Manages application configuration from `config.json`.

**Exported Functions:**
- `loadConfig()` - Load config.json file
- `getConfig()` - Get current configuration
- `getModelById(modelId)` - Find model by ID
- `getEndpointByType(type)` - Get endpoint configuration by type
- `isDevMode()` - Check if dev mode is enabled
- `getPort()` - Get server port (prioritizes ENV variable)
- `getSystemPrompt()` - Get system prompt text
- `getModelReasoning(modelId)` - Get reasoning level for model
- `getModelProvider(modelId)` - Get provider for model
- `getUserAgent()` - Get current user agent string
- `getProxyConfigs()` - Get proxy configurations
- `getRedirectedModelId(modelId)` - Handle model ID redirects

---

### **config.json** - Configuration File
Contains all application settings:

**Structure:**
- `port`: Server port (default: 3000)
- `model_redirects`: Model ID mapping for aliases
- `endpoint[]`: API endpoint configurations
  - `name`: Endpoint type (openai/anthropic/common)
  - `base_url`: Target API URL
- `proxies[]`: Proxy server configurations
- `models[]`: Available model definitions
  - `name`, `id`, `type`, `reasoning`, `provider`
- `dev_mode`: Enable detailed logging
- `user_agent`: Default user-agent string
- `system_prompt`: System prompt for AI responses

**Configured Models:**
- Anthropic: Opus 4.1, Haiku 4.5, Sonnet 4.5
- OpenAI: GPT-5, GPT-5-Codex, GPT-5.1, GPT-5.1-Codex
- Others: GLM-4.6, Gemini-3-Pro

---

### **auth.js** - Authentication Management
Handles API authentication with multiple strategies.

**Key Features:**
- **Priority 1:** `FACTORY_API_KEY` environment variable (fixed token)
- **Priority 2:** `DROID_REFRESH_KEY` with auto-refresh mechanism
- **Priority 3:** Client authorization header passthrough
- WorkOS OAuth integration
- Automatic token refresh (every 6 hours)
- Persistent storage in `auth.json`

**Key Functions:**
- `initializeAuth()` - Initialize authentication system
- `getAuthToken()` - Get current valid auth token
- Token refresh and persistence logic

---

### **proxy-manager.js** - Proxy Management
Manages HTTP proxy rotation for outbound requests.

**Key Features:**
- Round-robin proxy selection
- Proxy configuration validation
- Automatic failover to next proxy
- Configuration change detection
- HTTPS proxy support via `HttpsProxyAgent`

**Exported Functions:**
- `getNextProxyAgent(targetUrl)` - Get next proxy agent in rotation

---

### **logger.js** - Logging Utilities
Provides structured logging throughout the application.

**Exported Functions:**
- `logInfo(message, data)` - Info level logging
- `logDebug(message, data)` - Debug logging (dev mode only)
- `logError(message, error)` - Error logging
- `logRequest(method, url, headers, body)` - Log HTTP requests (dev mode)
- `logResponse(status, headers, body)` - Log HTTP responses (dev mode)

**Behavior:**
- Dev mode shows detailed information
- Production mode shows minimal information
- Automatic JSON formatting of data objects

---

### **user-agent-updater.js** - User-Agent Management
Automatically updates the user-agent version string.

**Key Features:**
- Fetches latest version from Factory CDN
- Updates every hour
- Retry logic with 3 attempts
- Fallback to config version on failure
- Version format validation

**Constants:**
- `VERSION_URL`: https://downloads.factory.ai/factory-cli/LATEST
- `CHECK_INTERVAL`: 1 hour
- `RETRY_INTERVAL`: 1 minute
- `MAX_RETRIES`: 3

**Exported Functions:**
- `getCurrentUserAgent()` - Get current user-agent string
- `initializeUserAgentUpdater()` - Start auto-update service

---

### **transformers/** - Request/Response Transformers

#### **request-anthropic.js**
Transforms OpenAI format to Anthropic API format.

**Key Transformations:**
- Convert messages format
- Handle system messages
- Transform tool/function calls
- Apply reasoning level settings (thinking mode, budget_tokens)
- Add anthropic-beta headers when needed

#### **request-openai.js**
Transforms requests for OpenAI API endpoints.

**Key Transformations:**
- Message format standardization
- Apply reasoning effort levels
- Handle tool calls
- Streaming parameter management

#### **request-common.js**
Common request transformations for generic endpoints.

**Key Features:**
- Standard OpenAI format passthrough
- Basic parameter normalization

#### **response-anthropic.js**
Transforms Anthropic API responses to OpenAI format.

**Key Transformations:**
- Convert message structure
- Transform content blocks
- Handle thinking blocks (reasoning)
- Convert tool use to function calls
- Support both streaming and non-streaming

#### **response-openai.js**
Transforms OpenAI API responses to standard format.

**Key Transformations:**
- Response normalization
- Streaming data handling
- Token usage tracking
- Reasoning content extraction

---

## 🔧 Key Features

### 1. **Dual Authorization Mechanism**
- Fixed API key (FACTORY_API_KEY) - highest priority
- Auto-refresh token (DROID_REFRESH_KEY) - second priority
- Client authorization passthrough - fallback
- No-auth mode - graceful degradation

### 2. **Intelligent Reasoning Control**
- Five reasoning levels: `auto`, `off`, `low`, `medium`, `high`
- `auto`: Respects client request parameters
- Fixed levels: Override client settings
- Provider-specific implementations:
  - **OpenAI**: `reasoning_effort` parameter
  - **Anthropic**: `thinking` mode + `budget_tokens`

### 3. **Model Redirection**
Maps common model names to actual model IDs:
- `claude-3-5-haiku-20241022` → `claude-haiku-4-5-20251001`
- `claude-sonnet-4-5` → `claude-sonnet-4-5-20250929`
- `gpt-5` → `gpt-5-2025-08-07`

### 4. **Proxy Support**
- Multiple proxy servers
- Round-robin load balancing
- Automatic failover
- HTTPS proxy support

### 5. **Streaming Support**
- Full SSE (Server-Sent Events) support
- Respects client `stream` parameter
- Real-time token streaming
- Proper connection handling

---

## 🌐 API Endpoints

### Health Check
```
GET /
Response: "droid2api is running"
```

### List Models
```
GET /v1/models
Response: { object: "list", data: [...models] }
```

### OpenAI-Compatible Chat
```
POST /v1/chat/completions
Body: Standard OpenAI chat completion request
```

### Direct OpenAI Proxy
```
POST /v1/responses
Body: OpenAI format request
Target: Factory.ai OpenAI endpoint
```

### Direct Anthropic Proxy
```
POST /v1/messages
Body: Anthropic format request
Target: Factory.ai Anthropic endpoint
```

---

## 🔐 Authentication Configuration

### Option 1: Fixed API Key (Production)
```bash
export FACTORY_API_KEY=your_factory_api_key_here
```

### Option 2: Refresh Token (Auto-refresh)
```bash
export DROID_REFRESH_KEY=your_refresh_token_here
```

### Option 3: Client Authorization
No configuration needed - uses client's Authorization header

---

## 🐳 Deployment Options

### Local Server
```bash
npm install
npm start
```

### Docker
```bash
docker build -t droid2api .
docker run -p 3000:3000 \
  -e FACTORY_API_KEY=your_key \
  droid2api
```

### Docker Compose
```bash
docker-compose up -d
```

---

## 📊 Configuration Examples

### Model Configuration
```json
{
  "name": "Sonnet 4.5",
  "id": "claude-sonnet-4-5-20250929",
  "type": "anthropic",
  "reasoning": "auto",
  "provider": "anthropic"
}
```

### Endpoint Configuration
```json
{
  "name": "anthropic",
  "base_url": "https://api.factory.ai/api/llm/a/v1/messages"
}
```

### Proxy Configuration
```json
{
  "name": "Proxy 1",
  "url": "http://proxy.example.com:8080"
}
```

---

## 🔍 Development Mode

Enable detailed logging:
```json
{
  "dev_mode": true
}
```

**Dev Mode Features:**
- Full request/response logging
- Detailed error stack traces
- Debug-level messages
- Header and body inspection

---

## 📦 Dependencies

**Runtime:**
- `express` (^4.18.2) - Web framework
- `node-fetch` (^3.3.2) - HTTP client
- `https-proxy-agent` (^7.0.2) - Proxy support

**Environment:**
- Node.js 24+ (Alpine for Docker)
- ES Module support

---

## 🎯 Use Cases

1. **Unified LLM Access** - Single API for multiple providers
2. **Claude Code Integration** - Direct proxy for Claude Code CLI
3. **API Key Management** - Centralized authentication
4. **Reasoning Control** - Fine-tuned model behavior
5. **Development Testing** - Local proxy for LLM development

---

## 🚀 Quick Start

1. Clone repository
2. Install dependencies: `npm install`
3. Configure authentication in `.env` or environment
4. Customize `config.json` if needed
5. Start server: `npm start`
6. Access at `http://localhost:3000`

---

## 📝 Notes

- Server prioritizes `PORT` environment variable over config
- Auth tokens refresh every 6 hours automatically
- User-agent updates every hour from Factory CDN
- No-auth mode allows client-side authorization
- All requests logged in dev mode
- Model redirects processed before routing

---

## 🔗 External Resources

- Factory.ai API: https://api.factory.ai
- Factory CLI Downloads: https://downloads.factory.ai/factory-cli/
- QQ Discussion Group: 824743643

---

*Last Updated: Generated automatically*
