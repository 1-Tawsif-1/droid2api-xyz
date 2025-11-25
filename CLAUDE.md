# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

droid2api is an OpenAI-compatible API proxy server that provides unified access to different LLM models (OpenAI, Anthropic, Google, etc.) through a standardized interface. It acts as a middleware layer that handles authentication, request transformation, response streaming, and reasoning level control.

**Note:** This project uses ES modules (`"type": "module"` in package.json). Use `import`/`export` syntax, not `require()`.

## Development Commands

### Running the Server
```bash
npm start              # Start the server (production)
npm run dev            # Start in development mode
```

### Docker Deployment
```bash
# Using docker-compose (recommended)
docker-compose up -d
docker-compose logs -f
docker-compose down

# Using Dockerfile directly
docker build -t droid2api .
docker run -d -p 3000:3000 -e DROID_REFRESH_KEY="token" --name droid2api droid2api
```

### Testing Endpoints
```bash
# Check available models
curl http://localhost:3000/v1/models

# Health check
curl http://localhost:3000/health

# Test chat completion
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-5-20250929", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Architecture

### Core Components

**server.js** - Express application entry point
- Initializes Express with CORS and JSON middleware
- Sets up health check endpoints (/health, /ping)
- Loads configuration and initializes auth system
- Binds to 0.0.0.0:PORT for cloud platform compatibility

**routes.js** - Request routing and endpoint handlers
- `/v1/models` - Returns available models list
- `/v1/chat/completions` - Standard OpenAI format with automatic transformation
- `/v1/responses` - Direct OpenAI endpoint forwarding (no transformation)
- `/v1/messages` - Direct Anthropic endpoint forwarding (no transformation)
- `/v1/messages/count_tokens` - Anthropic token counting

**auth.js** - Three-tier authentication system
- Priority 1: FACTORY_API_KEY environment variable (fixed key, no refresh)
- Priority 2: Refresh token mechanism (DROID_REFRESH_KEY or ~/.factory/auth.json)
- Priority 3: Client authorization headers (fallback)
- Automatic token refresh every 6 hours using WorkOS OAuth

**config.js** - Configuration management
- Loads config.json with model definitions and endpoints
- Handles model ID redirects (e.g., claude-3-5-haiku -> claude-haiku-4-5)
- Manages reasoning levels (auto/off/low/medium/high)
- Prioritizes PORT environment variable over config.json

**proxy-manager.js** - HTTP proxy support
- Round-robin proxy selection from config.json proxies array
- Supports authenticated proxies (http://user:pass@host:port)
- Falls back to direct connection if no proxies configured

**logger.js** - Structured logging utility
- Provides logInfo, logDebug, logError, logRequest, logResponse functions
- Debug logging controlled by dev_mode in config.json

**transformers/** - Request/Response transformation modules
- `request-anthropic.js` - Converts OpenAI format to Anthropic format
- `request-openai.js` - Prepares requests for OpenAI endpoints
- `request-common.js` - Generic transformation for other providers
- `response-anthropic.js` - Converts Anthropic streaming responses to OpenAI format
- `response-openai.js` - Converts OpenAI /v1/responses format to chat completions

### Request Transformation Flow

1. Client sends request to `/v1/chat/completions`
2. Model ID is resolved through redirects (config.json model_redirects)
3. Model type determines transformation path:
   - **anthropic**: transformers/request-anthropic.js
   - **openai**: transformers/request-openai.js
   - **common**: transformers/request-common.js
4. System prompt is injected (from config.json system_prompt)
5. Reasoning level is applied based on model configuration
6. Request is forwarded to appropriate Factory API endpoint
7. Response is transformed back to OpenAI format if needed

### Reasoning Level System

Each model in config.json has a `reasoning` field:
- **auto**: Pass through client's reasoning parameters unchanged
- **off**: Remove all reasoning fields
- **low/medium/high**: Force specific reasoning level

For Anthropic models (thinking field):
- low: 4096 budget_tokens
- medium: 12288 budget_tokens
- high: 24576 budget_tokens

For OpenAI models (reasoning field):
- low/medium/high: Sets effort parameter accordingly

### Direct Forwarding Endpoints

`/v1/responses` and `/v1/messages` bypass transformation:
- Used by Claude Code CLI for transparent proxying
- System prompts are still injected (instructions for OpenAI, system for Anthropic)
- Reasoning levels are still applied
- Authentication headers are added automatically
- Streaming responses are forwarded without modification

## Configuration Files

**config.json** - Main configuration
- `port`: Server port (overridden by PORT env var)
- `model_redirects`: Map old model IDs to new ones
- `endpoint`: Array of provider endpoints (openai, anthropic, common)
- `proxies`: Array of HTTP proxy configurations
- `models`: Array of model definitions with type, reasoning, and provider
- `dev_mode`: Enable debug logging
- `user_agent`: User agent string for requests
- `system_prompt`: Injected into all requests

**package.json** - Node.js dependencies
- express: Web server framework
- node-fetch: HTTP client
- https-proxy-agent: Proxy support

## Authentication Configuration

Three methods (in priority order):

1. **Fixed API Key with Fallback Support** (highest priority)
   ```bash
   export FACTORY_API_KEY="your_primary_key"
   export FACTORY_API_KEY_2="your_fallback_key_2"  # Optional
   export FACTORY_API_KEY_3="your_fallback_key_3"  # Optional
   export FACTORY_API_KEY_4="your_fallback_key_4"  # Optional
   export FACTORY_API_KEY_5="your_fallback_key_5"  # Optional
   export FACTORY_API_KEY_6="your_fallback_key_6"  # Optional
   export FACTORY_API_KEY_7="your_fallback_key_7"  # Optional
   ```
   - Supports up to 7 Factory API keys for automatic fallback
   - When primary key fails (quota/auth error), automatically rotates to next key
   - Detailed logging shows which key is active and when rotation occurs
   - Status codes triggering fallback: 429 (quota), 401/403 (auth), 402 (payment)

2. **Refresh Token** (auto-refresh every 6 hours)
   ```bash
   export DROID_REFRESH_KEY="your_refresh_token"
   ```
   Or create `~/.factory/auth.json`:
   ```json
   {
     "access_token": "...",
     "refresh_token": "..."
   }
   ```

3. **Client Authorization** (fallback)
   - Uses Authorization or x-api-key header from client request

## Key Implementation Details

### Factory API Key Fallback System
The system supports automatic failover between multiple Factory API keys (up to 7):
- **Load Phase**: Reads FACTORY_API_KEY through FACTORY_API_KEY_7 from environment
- **Detection**: Monitors response status codes (429, 401, 403, 402) indicating quota/auth failures
- **Rotation**: Automatically switches to next available key when current key fails
- **Logging**: Detailed console output shows key rotation events with timestamps
- **Retry Logic**: Retries failed request with new key immediately (max 2 attempts per rotation)
- **Persistence**: Current key index maintained in memory (resets on server restart)

Example log output on startup:
```
================================================================================
✅ FACTORY API KEYS LOADED SUCCESSFULLY
================================================================================
Total keys loaded: 7/7
Keys will be used as fallback one after another on quota/auth errors
--------------------------------------------------------------------------------
  Key #1: FACTORY_API_KEY (fk-US31AJQaqUu0...)
  Key #2: FACTORY_API_KEY_2 (fk-cf5u10QZaZzn...)
  Key #3: FACTORY_API_KEY_3 (fk-93NNcgMm3vg6...)
  Key #4: FACTORY_API_KEY_4 (fk-0KhK1ycmkumb...)
  Key #5: FACTORY_API_KEY_5 (fk-4bGGvtKADKEd...)
  Key #6: FACTORY_API_KEY_6 (fk-25zdmurIxwg2...)
  Key #7: FACTORY_API_KEY_7 (fk-xxxxxxxx...)
================================================================================
```

Example log output when fallback occurs:
```
================================================================================
⚠️  API KEY FAILURE DETECTED
================================================================================
Endpoint: chat completions
Status: 429
Error: Quota exceeded for current billing period
Attempt: 1/2
================================================================================

================================================================================
🔄 FACTORY API KEY ROTATION
================================================================================
Previous key: #1 (sk_factory...)
New active key: #2 (sk_factory...)
Reason: Previous key failed (quota exceeded or authentication error)
================================================================================

================================================================================
✅ FALLBACK KEY SUCCESS
================================================================================
Endpoint: chat completions
Active key: #2/2
Status: 200
================================================================================
```

### Model Provider Header Injection
The `x-api-provider` header is automatically added based on the model's `provider` field in config.json. This allows Factory API to route requests to the correct upstream provider (anthropic, openai, google, fireworks, etc.).

### Streaming Response Handling
- Anthropic/OpenAI types use response transformers for format conversion
- Common type directly forwards raw stream chunks
- All streaming uses Server-Sent Events (text/event-stream)

### Error Handling
- 404 handler logs detailed request information for debugging
- Auth failures return 500 with descriptive error messages
- Endpoint errors are logged and forwarded with status codes

### Port Binding
Server binds to 0.0.0.0 (all interfaces) instead of localhost for cloud platform compatibility (Render, Railway, etc.).

## Adding New Models

Edit config.json and add to the models array:
```json
{
  "name": "Model Display Name",
  "id": "model-id-string",
  "type": "anthropic|openai|common",
  "reasoning": "auto|off|low|medium|high",
  "provider": "anthropic|openai|google|fireworks"
}
```

The `type` field determines which endpoint and transformer to use:
- **anthropic**: For Claude models - uses Anthropic Messages API format
- **openai**: For GPT models - uses OpenAI Responses API format
- **common**: For other providers (Google, Fireworks) - uses standard chat completions format with raw stream forwarding

The `provider` field sets the x-api-provider header for Factory API routing.
