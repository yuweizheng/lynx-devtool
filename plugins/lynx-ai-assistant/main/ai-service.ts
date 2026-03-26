// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import Anthropic from '@anthropic-ai/sdk';
import axios, { AxiosError } from 'axios';
import { MCPClientManager } from './mcp-client-manager';
import * as fs from 'fs';
import * as path from 'path';

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
  target?: { clientId?: string; sessionId?: number };
}

export class AIService {
  private config: AIConfig = {
    baseURL: 'https://ark-cn-beijing.bytedance.net/api/v3',
    provider: 'ark',
    apiKey: 'b16a860e-7895-4156-81e0-596472f9e18d',
    model: 'ep-20251222145042-ndr5f'
  };
  
  private conversationHistory: ChatMessage[] = [];
  private anthropicClient?: Anthropic;
  private mcpClientManager: MCPClientManager;
  private cdpExecutor?: (
    method: string,
    params: any,
    type?: 'CDP' | 'App' | 'Device'
  ) => Promise<any>;
  private cdpTools: any[] = [];

  constructor(mcpClientManager: MCPClientManager, cdpExecutor?: (
    method: string,
    params: any,
    type?: 'CDP' | 'App' | 'Device'
  ) => Promise<any>) {
    this.mcpClientManager = mcpClientManager;
    this.cdpExecutor = cdpExecutor;
    this.cdpTools = this.loadCDPTools();
    this.initializeClient();
  }

  private loadCDPTools(): any[] {
    try {
      const toolsPath = path.join(__dirname, 'resources/cdp-tools.json');
      if (fs.existsSync(toolsPath)) {
        const content = fs.readFileSync(toolsPath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (e) {
      console.error('Failed to load CDP tools:', e);
    }
    return [];
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
    const sanitized: Partial<AIConfig> = { ...newConfig };
    for (const key of Object.keys(sanitized) as Array<keyof AIConfig>) {
      const value = sanitized[key];
      if (value === undefined || value === null) {
        delete sanitized[key];
        continue;
      }
      if (typeof value === 'string' && value.trim() === '') {
        delete sanitized[key];
      }
    }
    this.config = { ...this.config, ...sanitized };
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

    const url = this.getArkResponsesUrl();
    const mcpTools = await this.mcpClientManager.listTools();
    const availableTools = [...mcpTools, ...this.cdpTools];
    const arkTools = this.toArkTools(availableTools);
    const payload = this.createArkInitialPayload(systemMessage, arkTools);

    try {
      const initialData = await this.postArk(url, payload);
      const { text, usedTools } = await this.runArkToolLoop({
        url,
        systemMessage,
        arkTools,
        availableTools,
        initialData,
        maxRounds: 4,
        target: options?.target
      });
      const assistantMessage: ChatMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: text || 'No response',
        timestamp: new Date(),
        metadata: {
          mcpToolsUsed: usedTools
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

  private getArkResponsesUrl(): string {
    const urlBase = this.config.baseURL?.replace(/\/+$/, '') || 'https://ark-cn-beijing.bytedance.net/api/v3';
    return `${urlBase}/responses`;
  }

  private toArkTools(availableTools: any[]): any[] {
    return availableTools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }));
  }

  private createArkInitialPayload(systemMessage: string, arkTools: any[]): any {
    const input = [
      { type: 'message', role: 'system', content: systemMessage },
      ...this.conversationHistory
        .filter(msg => msg.role !== 'system')
        .map(msg => ({ type: 'message', role: msg.role, content: msg.content }))
    ];

    return {
      model: this.config.model!,
      store: true,
      input,
      tools: arkTools
    };
  }

  private async postArk(url: string, payload: any): Promise<any> {
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    return resp.data;
  }

  private parseArkToolCalls(d: any, availableTools: any[]): Array<{ id?: string; name: string; arguments: any }> {
    const calls: Array<{ id?: string; name: string; arguments: any }> = [];
    if (Array.isArray(d?.tool_calls)) {
      for (const tc of d.tool_calls) {
        if (tc?.name) {
          calls.push({
            id: tc?.id || tc?.call_id || tc?.tool_call_id,
            name: tc.name,
            arguments: tc.arguments ?? {}
          });
        }
      }
    }
    if (Array.isArray(d?.output)) {
      for (const item of d.output) {
        if ((item?.type === 'tool_call' || item?.type === 'function_call') && item?.name) {
          calls.push({
            id: item?.id || item?.call_id || item?.tool_call_id,
            name: item.name,
            arguments: item.arguments ?? {}
          });
        }
      }
    }
    const inferredText = this.extractArkAssistantText(d);
    if (calls.length === 0 && typeof inferredText === 'string' && inferredText.length > 0) {
      const inferred = this.extractToolCallsFromText(inferredText, availableTools);
      if (inferred.length > 0) {
        calls.push(...inferred);
      }
    }
    return calls;
  }

  private getToolCategory(toolName: string): 'cdp' | 'app' | 'jsb' | 'pia' | 'device' {
    if (toolName.startsWith('App_')) return 'app';
    if (toolName.startsWith('JSB_')) return 'jsb';
    if (toolName.startsWith('PIA_')) return 'pia';
    if (toolName.startsWith('Device_')) return 'device';
    return 'cdp';
  }

  
  private convertToolNameToMethod(toolName: string): string {
    const parts = toolName.split('_');
    if (parts.length < 2) return toolName;
    return parts[0] + '.' + parts.slice(1).join('_');
  }

  private normalizeToolArguments(args: any): any {
    if (args === undefined || args === null) return {};
    if (typeof args === 'string') {
      const s = args.trim();
      if (s.length === 0) return {};
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object') return parsed;
        return {};
      } catch {
        return {};
      }
    }
    if (typeof args === 'object') return args;
    return {};
  }

  private applyTargetDefaults(
    params: any,
    target?: { clientId?: string; sessionId?: number },
    category?: 'cdp' | 'app' | 'jsb' | 'pia' | 'device'
  ): any {
    if (!target) return params;
    if (!params || typeof params !== 'object') return params;
    const out: any = { ...params };

    if (target.clientId !== undefined) {
      if (out.clientId === undefined && out.client_id === undefined) {
        out.clientId = target.clientId;
      }
    }
    if (category === 'cdp' && target.sessionId !== undefined) {
      if (out.sessionId === undefined && out.session_id === undefined) {
        out.sessionId = target.sessionId;
      }
    }
    return out;
  }
  
  private async executeToolCalls(
    toolCalls: Array<{ id?: string; name: string; arguments: any }>,
    availableTools: any[],
    target?: { clientId?: string; sessionId?: number }
  ): Promise<Array<{ callId?: string; toolName: string; serverId: string; result?: any; error?: string }>> {
    const executedResults: Array<{ callId?: string; toolName: string; serverId: string; result?: any; error?: string }> =
      [];

    for (const call of toolCalls) {
      const cdpTool = this.cdpTools.find(t => t.name === call.name);
      if (cdpTool) {
        try {
          const category = this.getToolCategory(call.name);
          const method = this.convertToolNameToMethod(call.name);
          const params = this.applyTargetDefaults(this.normalizeToolArguments(call.arguments), target, category);
          
          if (category === 'device') {
            const result = await this.cdpExecutor?.(method, params, 'Device');
            executedResults.push({
              callId: call.id,
              toolName: call.name,
              serverId: 'internal-device',
              result
            });
          } else if (category === 'cdp') {
            const result = await this.cdpExecutor?.(method, params, 'CDP');
            executedResults.push({
              callId: call.id,
              toolName: call.name,
              serverId: 'internal-cdp',
              result
            });
          } else if (category === 'app' || category === 'jsb' || category === 'pia') {
            const result = await this.cdpExecutor?.(method, params, 'App');
            executedResults.push({
              callId: call.id,
              toolName: call.name,
              serverId: 'internal-app',
              result
            });
          }
        } catch (e: any) {
          executedResults.push({
            callId: call.id,
            toolName: call.name,
            serverId: 'internal-cdp',
            error: e.message
          });
        }
        continue;
      }
      const toolDef = availableTools.find(t => t.name === call.name);
      if (!toolDef) {
        executedResults.push({
          callId: call.id,
          toolName: call.name,
          serverId: '',
          error: `Tool not found: ${call.name}`
        });
        continue;
      }
      try {
        const r = await this.mcpClientManager.callTool(toolDef.serverId, toolDef.name, call.arguments ?? {});
        executedResults.push({ callId: call.id, toolName: toolDef.name, serverId: toolDef.serverId, result: r });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        console.error(`MCP tool call failed: ${toolDef.name}`, msg);
        executedResults.push({ callId: call.id, toolName: toolDef.name, serverId: toolDef.serverId, error: msg });
      }
    }

    return executedResults;
  }

  private formatToolResultsText(
    executedResults: Array<{ toolName: string; result?: any; error?: string }>
  ): string {
    return executedResults
      .map(r => {
        if (r.error) {
          return `Tool ${r.toolName}: ERROR ${JSON.stringify({ message: r.error })}`;
        }
        return `Tool ${r.toolName}: ${JSON.stringify(r.result)}`;
      })
      .join('\n\n');
  }

  private createArkFollowupPayload(args: {
    systemMessage: string;
    arkTools: any[];
    resultsText: string;
    canSendToolResults: boolean;
    responseId?: string;
    executedResults: Array<{ callId?: string; result?: any; error?: string }>;
  }): any {
    const base: any = {
      model: this.config.model!,
      store: true,
      tools: args.arkTools
    };

    if (args.canSendToolResults && typeof args.responseId === 'string' && args.responseId.length > 0) {
      base.previous_response_id = args.responseId;
      base.input = args.executedResults.map(r => ({
        type: 'function_call_output',
        call_id: r.callId,
        output: r.error ? JSON.stringify({ error: r.error }) : JSON.stringify(r.result)
      }));
      return base;
    }

    base.input = [
      { type: 'message', role: 'system', content: `${args.systemMessage}\n\nTool Results:\n${args.resultsText}` },
      ...this.conversationHistory
        .filter(msg => msg.role !== 'system')
        .map(msg => ({ type: 'message', role: msg.role, content: msg.content }))
    ];
    return base;
  }

  private async postArkFollowupWithFallback(args: {
    url: string;
    followupPayload: any;
    canSendToolResults: boolean;
    arkTools: any[];
    systemMessage: string;
    resultsText: string;
  }): Promise<any> {
    try {
      return await this.postArk(args.url, args.followupPayload);
    } catch (err) {
      const axiosErr = err as AxiosError<any>;
      const msg = axiosErr?.response?.data?.error?.message;
      console.error('Ark follow-up failed:', msg || (err instanceof Error ? err.message : 'Unknown error'));

      const invalidInputType =
        typeof msg === 'string' &&
        (msg.includes('input.type') || msg.includes('unknown type'));
      if (!invalidInputType || !args.canSendToolResults) {
        throw err;
      }

      const fallbackPayload: any = {
        model: this.config.model!,
        store: true,
        tools: args.arkTools,
        input: [
          { type: 'message', role: 'system', content: `${args.systemMessage}\n\nTool Results:\n${args.resultsText}` },
          ...this.conversationHistory
            .filter(msg => msg.role !== 'system')
            .map(msg => ({ type: 'message', role: msg.role, content: msg.content }))
        ]
      };

      return await this.postArk(args.url, fallbackPayload);
    }
  }

  private async runArkToolLoop(args: {
    url: string;
    systemMessage: string;
    arkTools: any[];
    availableTools: any[];
    initialData: any;
    maxRounds: number;
    target?: { clientId?: string; sessionId?: number };
  }): Promise<{ text: string; usedTools: string[] | undefined }> {
    let currentData: any = args.initialData;
    let currentResponseId: string | undefined = (currentData as any)?.id;
    let text = this.extractArkAssistantText(currentData);
    const usedToolsSet = new Set<string>();

    for (let step = 0; step < args.maxRounds; step++) {
      const toolCalls = this.parseArkToolCalls(currentData, args.availableTools);
      if (toolCalls.length === 0) {
        break;
      }

      const executedResults = await this.executeToolCalls(toolCalls, args.availableTools, args.target);
      for (const r of executedResults) {
        if (r.toolName) {
          usedToolsSet.add(r.toolName);
        }
      }

      const resultsText = this.formatToolResultsText(executedResults);
      const canSendToolResults =
        typeof currentResponseId === 'string' &&
        currentResponseId.length > 0 &&
        executedResults.every(r => typeof r.callId === 'string' && r.callId.length > 0);

      const followupPayload = this.createArkFollowupPayload({
        systemMessage: args.systemMessage,
        arkTools: args.arkTools,
        resultsText,
        canSendToolResults,
        responseId: currentResponseId,
        executedResults
      });

      const followData = await this.postArkFollowupWithFallback({
        url: args.url,
        followupPayload,
        canSendToolResults,
        arkTools: args.arkTools,
        systemMessage: args.systemMessage,
        resultsText
      });

      currentData = followData;
      const newId = (currentData as any)?.id;
      if (typeof newId === 'string' && newId.length > 0) {
        currentResponseId = newId;
      }
      const followText = this.extractArkAssistantText(currentData);
      if (followText) {
        text = followText;
      }
    }

    const usedTools = usedToolsSet.size > 0 ? Array.from(usedToolsSet) : undefined;
    return { text, usedTools };
  }

  async getConversationHistory(): Promise<ChatMessage[]> {
    return [...this.conversationHistory];
  }

  async clearConversation(): Promise<void> {
    this.conversationHistory = [];
  }

  private extractArkAssistantText(data: any): string {
    const normalize = (content: any): string => {
      if (content === undefined || content === null) {
        return '';
      }
      if (typeof content === 'string') {
        return content;
      }
      if (Array.isArray(content)) {
        return content.map(normalize).join('');
      }
      if (typeof content === 'object') {
        const anyContent: any = content;
        if (typeof anyContent.text === 'string') {
          return anyContent.text;
        }
        if (typeof anyContent.content === 'string') {
          return anyContent.content;
        }
        if (Array.isArray(anyContent.content)) {
          return normalize(anyContent.content);
        }
        return JSON.stringify(anyContent);
      }
      return String(content);
    };

    if (Array.isArray(data?.output) && data.output.length > 0) {
      const firstAssistant = data.output.find((i: any) => i?.type === 'message' && i?.role === 'assistant');
      const first = firstAssistant || data.output.find((i: any) => i?.type === 'message') || data.output[0];
      const text = normalize(first?.content);
      return typeof text === 'string' ? text.trim() : '';
    }
    if (data?.choices?.[0]?.message?.content !== undefined) {
      const text = normalize(data.choices[0].message.content);
      return typeof text === 'string' ? text.trim() : '';
    }
    if (data?.message?.content !== undefined) {
      const text = normalize(data.message.content);
      return typeof text === 'string' ? text.trim() : '';
    }
    if (data?.result !== undefined) {
      const text = normalize(data.result);
      return typeof text === 'string' ? text.trim() : '';
    }
    return '';
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

You have access to the following tools:

**CDP Tools (Chrome DevTools Protocol)** - Use these to inspect and debug the running application:
- DOM_getDocument, DOM_querySelector, DOM_getAttributes: Inspect the DOM tree
- CSS_getComputedStyleForNode, CSS_getMatchedStylesForNode: Analyze CSS styles
- Runtime_listConsole: Get console messages and errors
- Page_takeScreenshot: Capture screenshots of the current page
- Device_listDevices, Device_listClients, Device_listSessions: List connected devices and sessions
- Debugger_listScripts, Debugger_getScriptSource: Inspect JavaScript source code
- PIA_* tools: Lynx-specific performance and debugging tools
- App_* tools: Lynx app-level debugging tools

**MCP Tools** - External tools for file access, search, and other capabilities.

When debugging console errors or red screen errors:
1. First use Device_listClients to get the clientId
2. Then use Device_listSessions to get the sessionId
3. Use Runtime_listConsole to get detailed console messages with stack traces
4. Use DOM tools to inspect the relevant elements if needed
5. Use PIA tools to analyze Lynx-specific performance data

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
