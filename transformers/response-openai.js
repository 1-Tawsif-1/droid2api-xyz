import { logDebug } from '../logger.js';

export class OpenAIResponseTransformer {
  constructor(model, requestId) {
    this.model = model;
    this.requestId = requestId || `chatcmpl-${Date.now()}`;
    this.created = Math.floor(Date.now() / 1000);
    // Tool call tracking
    this.toolCalls = new Map(); // Map of item_id -> {index, id, name, arguments}
    this.toolCallIndex = 0;
  }

  parseSSELine(line) {
    if (line.startsWith('event:')) {
      return { type: 'event', value: line.slice(6).trim() };
    }
    if (line.startsWith('data:')) {
      const dataStr = line.slice(5).trim();
      try {
        return { type: 'data', value: JSON.parse(dataStr) };
      } catch (e) {
        return { type: 'data', value: dataStr };
      }
    }
    return null;
  }

  transformEvent(eventType, eventData) {
    logDebug(`Target OpenAI event: ${eventType}`);

    if (eventType === 'response.created') {
      return this.createOpenAIChunk('', 'assistant', false);
    }

    if (eventType === 'response.in_progress') {
      return null;
    }

    // Handle text delta events (multiple formats) - always include role
    if (eventType === 'response.output_text.delta' || 
        eventType === 'response.text.delta' ||
        eventType === 'response.content_part.delta') {
      const text = eventData.delta || eventData.text || '';
      return this.createOpenAIChunk(text, 'assistant', false);
    }

    if (eventType === 'response.output_text.done' ||
        eventType === 'response.text.done' ||
        eventType === 'response.content_part.done') {
      return null;
    }
    
    // Handle content part added
    if (eventType === 'response.content_part.added' ||
        eventType === 'response.output_item.added') {
      // Check if it's a text part (not function call)
      const item = eventData.item || eventData.part;
      if (item && item.type === 'output_text') {
        return null; // Text parts don't need special handling on add
      }
      // Fall through for function_call handling below
    }

    // Handle tool call (function call) output item added
    if (eventType === 'response.output_item.added') {
      const item = eventData.item;
      if (item && item.type === 'function_call') {
        const toolCallId = item.call_id || item.id || `call_${Date.now()}`;
        const index = this.toolCallIndex++;
        
        this.toolCalls.set(item.id, {
          index: index,
          id: toolCallId,
          name: item.name || '',
          arguments: ''
        });
        
        // Emit initial tool call chunk with function name
        return this.createToolCallChunk(index, toolCallId, item.name || '', '', true);
      }
      return null;
    }

    // Handle streaming function call arguments
    if (eventType === 'response.function_call_arguments.delta') {
      const itemId = eventData.item_id;
      const delta = eventData.delta || '';
      
      const toolCall = this.toolCalls.get(itemId);
      if (toolCall) {
        toolCall.arguments += delta;
        // Emit argument delta chunk
        return this.createToolCallChunk(toolCall.index, toolCall.id, null, delta, false);
      }
      return null;
    }

    // Handle function call arguments complete
    if (eventType === 'response.function_call_arguments.done') {
      // Arguments are complete, no need to emit anything special
      return null;
    }

    // Handle complete tool call (response.output_item.done) - CLIProxyAPI style
    if (eventType === 'response.output_item.done') {
      const item = eventData.item;
      if (item && item.type === 'function_call') {
        const toolCallId = item.call_id || item.id || `call_${Date.now()}`;
        const index = this.toolCallIndex++;
        
        // Emit complete tool call in one chunk
        return this.createCompleteToolCallChunk(index, toolCallId, item.name || '', item.arguments || '{}');
      }
      return null;
    }

    if (eventType === 'response.done' || eventType === 'response.completed') {
      const status = eventData.response?.status || eventData.status || 'completed';
      let finishReason = 'stop';
      
      if (status === 'completed') {
        // Check if we had tool calls
        finishReason = this.toolCalls.size > 0 ? 'tool_calls' : 'stop';
      } else if (status === 'incomplete') {
        finishReason = 'length';
      }

      this.isDone = true;
      const finalChunk = this.createOpenAIChunk('', null, true, finishReason);
      const done = this.createDoneSignal();
      return finalChunk + done;
    }

    // Ignore other events silently
    return null;
  }

  createOpenAIChunk(content, role = null, finish = false, finishReason = null) {
    const chunk = {
      id: this.requestId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finish ? finishReason : null
        }
      ]
    };

    if (role) {
      chunk.choices[0].delta.role = role;
    }
    if (content) {
      chunk.choices[0].delta.content = content;
    }

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  createDoneSignal() {
    return 'data: [DONE]\n\n';
  }

  createToolCallChunk(index, toolCallId, functionName, argumentsDelta, isFirst) {
    const chunk = {
      id: this.requestId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: index
              }
            ]
          },
          finish_reason: null
        }
      ]
    };

    const toolCallDelta = chunk.choices[0].delta.tool_calls[0];

    // On first chunk, include id, type, and function name
    if (isFirst) {
      toolCallDelta.id = toolCallId;
      toolCallDelta.type = 'function';
      toolCallDelta.function = {
        name: functionName,
        arguments: ''
      };
    } else {
      // On subsequent chunks, only include arguments delta
      toolCallDelta.function = {
        arguments: argumentsDelta
      };
    }

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  // Create a complete tool call chunk (for response.output_item.done event)
  createCompleteToolCallChunk(index, toolCallId, functionName, functionArgs) {
    const chunk = {
      id: this.requestId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      system_fingerprint: 'fp_factory',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: index,
                id: toolCallId,
                type: 'function',
                function: {
                  name: functionName,
                  arguments: functionArgs
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    };

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  async *transformStream(sourceStream) {
    let buffer = '';
    let currentEvent = null;
    this.isDone = false;

    try {
      for await (const chunk of sourceStream) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          const parsed = this.parseSSELine(line);
          if (!parsed) continue;

          if (parsed.type === 'event') {
            currentEvent = parsed.value;
          } else if (parsed.type === 'data' && currentEvent) {
            const transformed = this.transformEvent(currentEvent, parsed.value);
            if (transformed) {
              yield transformed;
            }
            currentEvent = null; // Reset after processing
          }
        }
      }

      // Ensure DONE signal is sent if stream ended without response.done
      if (!this.isDone) {
        yield this.createOpenAIChunk('', null, true, 'stop');
        yield this.createDoneSignal();
      }
    } catch (error) {
      logDebug('Error in OpenAI stream transformation', error);
      // Send DONE signal even on error to prevent client hanging
      if (!this.isDone) {
        yield this.createDoneSignal();
      }
      throw error;
    }
  }
}
