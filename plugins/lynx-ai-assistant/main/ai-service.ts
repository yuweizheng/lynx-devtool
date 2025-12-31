// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import Anthropic from '@anthropic-ai/sdk';
import axios, { AxiosError } from 'axios';
import { MCPClientManager } from './mcp-client-manager';

export interface AIConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  provider?: 'anthropic' | 'openai' | 'custom' | 'ark';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metadata?: {
    mcpToolsUsed?: string[];
    debugContext?: any;
  };
}

export interface SendMessageOptions {
  context?: any;
  mcpTools?: string[];
}

export class AIService {
  private config: AIConfig = {
    baseURL: 'https://ark-cn-beijing.bytedance.net/api/v3',
    provider: 'ark'
  };
  
  private conversationHistory: ChatMessage[] = [];
  private anthropicClient?: Anthropic;
  private mcpClientManager: MCPClientManager;

  constructor(mcpClientManager: MCPClientManager) {
    this.mcpClientManager = mcpClientManager;
    this.initializeClient();
  }

  private initializeClient() {
    if (this.config.provider === 'anthropic' && this.config.apiKey) {
      this.anthropicClient = new Anthropic({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL
      });
    } else {
      this.anthropicClient = undefined;
    }
  }

  async updateConfig(newConfig: Partial<AIConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    this.initializeClient();
  }

  async getConfig(): Promise<AIConfig> {
    // Return config without sensitive information
    return {
      ...this.config,
      apiKey: this.config.apiKey ? '***' : undefined
    };
  }

  async sendMessage(message: string, options?: SendMessageOptions): Promise<ChatMessage> {
    if (this.config.provider === 'anthropic' && !this.anthropicClient) {
      throw new Error('AI client not configured. Please set API key first.');
    }

    // Create user message
    const userMessage: ChatMessage = {
      id: this.generateMessageId(),
      role: 'user',
      content: message,
      timestamp: new Date(),
      metadata: {
        mcpToolsUsed: options?.mcpTools,
        debugContext: options?.context
      }
    };

    this.conversationHistory.push(userMessage);

    if (this.config.provider === 'ark') {
      return await this.sendMessageArk(options);
    }

    try {
      // Prepare system message with debug context if provided
      let systemMessage = this.getSystemPrompt();
      
      if (options?.context) {
        systemMessage += `\n\nCurrent Debug Context:\n${JSON.stringify(options.context, null, 2)}`;
      }

      // Prepare messages for API
      const messages = [
        ...this.conversationHistory
          .filter(msg => msg.role !== 'system')
          .map(msg => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content
          }))
      ];

      // Handle MCP tools if specified
      let toolResults: any[] = [];
      if (options?.mcpTools && options.mcpTools.length > 0) {
        toolResults = await this.handleMCPTools(options.mcpTools, message);
        
        if (toolResults.length > 0) {
          const toolResultsContent = toolResults
            .map(result => `Tool ${result.toolName}: ${JSON.stringify(result.result)}`)
            .join('\n\n');
          
          systemMessage += `\n\nTool Results:\n${toolResultsContent}`;
        }
      }

      // Send to AI
      const response = await this.anthropicClient!.messages.create({
        model: this.config.model!,
        max_tokens: 4000,
        system: systemMessage,
        messages
      });

      const assistantMessage: ChatMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: response.content[0]?.type === 'text' ? response.content[0].text : 'No response',
        timestamp: new Date(),
        metadata: {
          mcpToolsUsed: options?.mcpTools
        }
      };

      this.conversationHistory.push(assistantMessage);
      return assistantMessage;

    } catch (error) {
      console.error('AI Service error:', error);
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async sendMessageArk(options?: SendMessageOptions): Promise<ChatMessage> {
    if (!this.config.apiKey) {
      throw new Error('AI client not configured. Please set API key first.');
    }
    if (!this.config.model) {
      throw new Error('Ark model not configured. Please set model to your <ENDPOINT_ID>.');
    }

    let systemMessage = this.getSystemPrompt();
    if (options?.context) {
      systemMessage += `\n\nCurrent Debug Context:\n${JSON.stringify(options.context, null, 2)}`;
    }

    const urlBase = (this.config.baseURL?.replace(/\/+$/, '') || 'https://ark-cn-beijing.bytedance.net/api/v3');
    const url = `${urlBase}/responses`;

    const availableTools = await this.mcpClientManager.listTools();
    const arkTools = availableTools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }));

    const input = [
      { type: 'message', role: 'system', content: systemMessage },
      ...this.conversationHistory
        .filter(msg => msg.role !== 'system')
        .map(msg => ({ type: 'message', role: msg.role, content: msg.content }))
    ];

    const payload = {
      model: this.config.model!,
      store: true,
      input,
      tools: arkTools
    };

    try {
      const resp = await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      const data = resp.data;
      let text = '';
      if (Array.isArray(data?.output) && data.output.length > 0) {
        const firstAssistant = data.output.find((i: any) => i?.type === 'message' && i?.role === 'assistant');
        const first = firstAssistant || data.output[0];
        text = first?.content || '';
      } else if (data?.choices?.[0]?.message?.content) {
        text = data.choices[0].message.content;
      } else if (typeof data?.message?.content === 'string') {
        text = data.message.content;
      } else if (typeof data?.result === 'string') {
        text = data.result;
      } else {
        text = 'No response';
      }
      const toolCalls: Array<{ name: string; arguments: any }> = [];
      if (Array.isArray((data as any)?.tool_calls)) {
        for (const tc of (data as any).tool_calls) {
          if (tc?.name) {
            toolCalls.push({ name: tc.name, arguments: tc.arguments ?? {} });
          }
        }
      }
      if (Array.isArray((data as any)?.output)) {
        for (const item of (data as any).output) {
          if (item?.type === 'tool_call' && item?.name) {
            toolCalls.push({ name: item.name, arguments: item.arguments ?? {} });
          } else if (item?.type === 'function_call' && item?.name) {
            toolCalls.push({ name: item.name, arguments: item.arguments ?? {} });
          }
        }
      }
      if (toolCalls.length === 0 && typeof text === 'string') {
        const inferred = this.extractToolCallsFromText(text, availableTools);
        if (inferred.length > 0) {
          toolCalls.push(...inferred);
        }
      }
      if (toolCalls.length > 0) {
        const availableToolsExec = availableTools;
        const executedResults: Array<{ toolName: string; serverId: string; result: any }> = [];
        for (const call of toolCalls) {
          const toolDef = availableToolsExec.find(t => t.name === call.name);
          if (!toolDef) {
            continue;
          }
          try {
            const r = await this.mcpClientManager.callTool(toolDef.serverId, toolDef.name, call.arguments ?? {});
            executedResults.push({ toolName: toolDef.name, serverId: toolDef.serverId, result: r });
          } catch {
          }
        }
        if (executedResults.length > 0) {
          const resultsText = executedResults.map(r => `Tool ${r.toolName}: ${JSON.stringify(r.result)}`).join('\n\n');
          const followupInput = [
            { type: 'message', role: 'system', content: `${systemMessage}\n\nTool Results:\n${resultsText}` },
            ...this.conversationHistory
              .filter(msg => msg.role !== 'system')
              .map(msg => ({ type: 'message', role: msg.role, content: msg.content }))
          ];
          const followupPayload = {
            model: this.config.model!,
            store: true,
            input: followupInput,
            tools: arkTools
          };
          const followResp = await axios.post(url, followupPayload, {
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              'Content-Type': 'application/json'
            }
          });
          const followData = followResp.data;
          if (Array.isArray(followData?.output) && followData.output.length > 0) {
            const firstAssistant2 = followData.output.find((i: any) => i?.type === 'message' && i?.role === 'assistant');
            const first2 = firstAssistant2 || followData.output[0];
            text = first2?.content || text;
          } else if (followData?.choices?.[0]?.message?.content) {
            text = followData.choices[0].message.content;
          } else if (typeof followData?.message?.content === 'string') {
            text = followData.message.content;
          } else if (typeof followData?.result === 'string') {
            text = followData.result;
          }
        }
      }
      const assistantMessage: ChatMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: text,
        timestamp: new Date(),
        metadata: {
          mcpToolsUsed: availableTools.map(t => t.name)
        }
      };
      this.conversationHistory.push(assistantMessage);
      return assistantMessage;
    } catch (err) {
      const axiosErr = err as AxiosError<any>;
      if (axiosErr?.response?.data?.error?.message) {
        throw new Error(axiosErr.response.data.error.message);
      }
      if (err instanceof Error) {
        throw new Error(`Ark request failed: ${err.message}`);
      }
      throw new Error('Ark request failed: Unknown error');
    }
  }

  async getConversationHistory(): Promise<ChatMessage[]> {
    return [...this.conversationHistory];
  }

  async clearConversation(): Promise<void> {
    this.conversationHistory = [];
  }

  private extractToolCallsFromText(text: string, availableTools: any[]): Array<{ name: string; arguments: any }> {
    const calls: Array<{ name: string; arguments: any }> = [];
    const lower = text.toLowerCase();
    for (const tool of availableTools) {
      if (!tool?.name) {
        continue;
      }
      const name = String(tool.name);
      if (!lower.includes(name.toLowerCase())) {
        continue;
      }
      const args: any = {};
      const schema = tool.inputSchema || {};
      const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
        ? Object.keys(schema.properties)
        : [];
      for (const p of props) {
        let val: string | undefined;
        const reJson = new RegExp(`"${p}"\\s*:\\s*"([^"]+)"`, 'i');
        const m1 = text.match(reJson);
        if (m1 && m1[1]) {
          val = m1[1];
        }
        if (!val) {
          const rePlain = new RegExp(`${p}\\s*[:=]\\s*["']?([^"'\n]+)["']?`, 'i');
          const m2 = text.match(rePlain);
          if (m2 && m2[1]) {
            val = m2[1];
          }
        }
        if (val !== undefined) {
          args[p] = val;
        }
      }
      calls.push({ name, arguments: args });
    }
    return calls;
  }

  private async handleMCPTools(toolNames: string[], message: string): Promise<any[]> {
    const results: any[] = [];
    const availableTools = await this.mcpClientManager.listTools();

    for (const toolName of toolNames) {
      const tool = availableTools.find(t => t.name === toolName);
      if (!tool) {
        console.warn(`Tool ${toolName} not found`);
        continue;
      }

      try {
        // For now, pass the user message as context
        // In a real implementation, you'd parse the message for tool parameters
        const result = await this.mcpClientManager.callTool(
          tool.serverId, 
          tool.name, 
          { query: message }
        );

        results.push({
          toolName: tool.name,
          serverId: tool.serverId,
          result
        });
      } catch (error) {
        console.error(`Failed to call tool ${toolName}:`, error);
        results.push({
          toolName: tool.name,
          serverId: tool.serverId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return results;
  }

  private getSystemPrompt(): string {
    return `You are an AI assistant specialized in debugging and analyzing applications built with the Lynx cross-platform framework. 

Your capabilities include:
- Analyzing debugging information from mobile apps, simulators, and web environments
- Understanding JavaScript, TypeScript, and native code issues
- Helping with performance analysis and optimization
- Explaining error messages and stack traces
- Suggesting debugging strategies and fixes
- Working with debugging tools and logs

You have access to various MCP (Model Context Protocol) tools that can help you:
- Access file systems to examine code
- Search for information online
- Interact with external services

When providing assistance:
1. Be specific and actionable in your suggestions
2. Explain the reasoning behind your recommendations
3. Ask for clarification when the debugging context is insufficient
4. Prioritize solutions that are most likely to resolve the issue
5. Consider the cross-platform nature of Lynx applications

Always be helpful, accurate, and focused on solving the user's debugging needs.`;
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
} 
