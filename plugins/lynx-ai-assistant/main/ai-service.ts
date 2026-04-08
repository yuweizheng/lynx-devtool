// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import Anthropic from '@anthropic-ai/sdk';
import axios, { AxiosError } from 'axios';
import { MCPClientManager } from './mcp-client-manager';
import { getBuiltinToolDefinitions, executeBuiltinTool } from './builtin-tools';
import {
  CodexSDKDebugEvent,
  CodexSDKProgressEvent,
  CodexSDKService,
  CodexSandboxMode
} from './codex-sdk-service';
import {
  DEVTOOL_DEBUG_MCP_BOUND_CLIENT_ID_ENV,
  DEVTOOL_DEBUG_MCP_BOUND_SESSION_ID_ENV,
  DEVTOOL_DEBUG_MCP_SERVER_ID
} from '../shared/devtool-debug-mcp';
import * as fs from 'fs';
import * as path from 'path';

export type AIProvider = 'anthropic' | 'openai' | 'custom' | 'ark' | 'codex-sdk' | 'codex-cli';

export interface AIConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  provider?: AIProvider;
  codexCommand?: string;
  codexModel?: string;
  codexProfile?: string;
  codexSandbox?: CodexSandboxMode;
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
  sourceDirectory?: string;
  requestId?: string;
  onProgress?: (event: AIProgressEvent) => void;
}

export interface AIProgressEvent {
  phase: 'status' | 'delta' | 'snapshot' | 'error';
  source?: 'system' | 'codex';
  message?: string;
  text?: string;
  rawType?: string;
}

interface PromptToolContext {
  target?: { clientId?: string; sessionId?: number };
  nodeId?: number;
  backendNodeId?: number;
  nodeSummary?: any;
  scripts?: Array<{ scriptId: string; url?: string }>;
  errorMessage?: string;
}

interface WorkspaceFileSnapshot {
  mtimeMs: number;
  size: number;
}

export class AIService {
  private config: AIConfig = {
    provider: 'codex-sdk',
    codexSandbox: 'read-only'
  };
  // Temporary safety switch: keep Codex running on source/LynxBase only until
  // the SDK/app-server tool-calling path for local debug MCP is stable.
  private readonly codexLiveDebugMcpEnabled = false;
  
  private conversationHistory: ChatMessage[] = [];
  private anthropicClient?: Anthropic;
  private codexSDKService: CodexSDKService;
  private mcpClientManager: MCPClientManager;
  private cdpExecutor?: (
    method: string,
    params: any,
    type?: 'CDP' | 'App' | 'Device'
  ) => Promise<any>;
  private cdpTools: any[] = [];
  private builtinTools: any[] = [];

  constructor(mcpClientManager: MCPClientManager, cdpExecutor?: (
    method: string,
    params: any,
    type?: 'CDP' | 'App' | 'Device'
  ) => Promise<any>) {
    this.codexSDKService = new CodexSDKService();
    this.mcpClientManager = mcpClientManager;
    this.cdpExecutor = cdpExecutor;
    this.cdpTools = this.loadCDPTools();
    this.builtinTools = getBuiltinToolDefinitions();
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

  private normalizeProvider(provider?: AIProvider): AIProvider {
    if (!provider || provider === 'codex-cli') {
      return 'codex-sdk';
    }
    return provider;
  }

  private isCodexProvider(provider: AIProvider | undefined = this.config.provider): boolean {
    return this.normalizeProvider(provider) === 'codex-sdk';
  }

  private shouldUseCodexLiveDebugMcp(): boolean {
    return this.codexLiveDebugMcpEnabled;
  }

  private reportDbg(payload: Record<string, any>) {
    try {
      const preview =
        payload && typeof payload === 'object'
          ? JSON.stringify({
              hypothesisId: payload.hypothesisId ?? 'H?',
              msg: payload.msg ?? '[DEBUG] ai-service',
              location: payload.location,
              data: payload.data
            })
          : String(payload);
      console.log('[AI dbg][main]', preview);
    } catch {}
  }

  private emitProgress(
    reporter: ((event: AIProgressEvent) => void) | undefined,
    event: AIProgressEvent
  ): void {
    try {
      reporter?.(event);
    } catch {
      // Ignore UI progress callback failures.
    }
  }

  private emitStatus(
    reporter: ((event: AIProgressEvent) => void) | undefined,
    message: string,
    source: 'system' | 'codex' = 'system',
    rawType?: string
  ): void {
    this.emitProgress(reporter, {
      phase: 'status',
      source,
      message,
      rawType
    });
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
    if (sanitized.provider) {
      sanitized.provider = this.normalizeProvider(sanitized.provider);
    }
    this.config = { ...this.config, ...sanitized };
    this.initializeClient();
  }

  async getConfig(): Promise<AIConfig> {
    // Return config without sensitive information
    return {
      ...this.config,
      provider: this.normalizeProvider(this.config.provider),
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

    if (this.isCodexProvider()) {
      return await this.sendMessageCodexSDK(message, options);
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

  private async sendMessageCodexSDK(
    message: string,
    options?: SendMessageOptions
  ): Promise<ChatMessage> {
    this.emitStatus(options?.onProgress, 'Preparing Codex SDK request...');
    const codexToolPlan = options?.mcpTools?.length
      ? await this.buildRecommendedCodexToolPlan('chat', options.mcpTools)
      : { requestedToolNames: undefined, hasLynxBaseTools: false };
    const prompt = this.buildCodexChatPrompt({
      message,
      sourceDirectory: options?.sourceDirectory,
      debugContext: options?.context,
      toolContext: undefined
    });

    if (options?.sourceDirectory) {
      this.emitStatus(options.onProgress, 'Using the mounted source directory as additional context.');
    }
    const responseText = await this.runCodexPrompt(
      prompt,
      options?.sourceDirectory,
      codexToolPlan.requestedToolNames || options?.target
        ? {
            ...(codexToolPlan.requestedToolNames ? { requestedToolNames: codexToolPlan.requestedToolNames } : {}),
            ...(options?.target ? { target: options.target } : {})
          }
        : undefined,
      options?.onProgress
    );
    const assistantMessage: ChatMessage = {
      id: options?.requestId || this.generateMessageId(),
      role: 'assistant',
      content: responseText,
      timestamp: new Date(),
      metadata: {
        mcpToolsUsed: codexToolPlan.requestedToolNames
      }
    };

    this.conversationHistory.push(assistantMessage);
    return assistantMessage;
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
      // Handle builtin tools (read_file, grep_source, etc.)
      if (call.name.startsWith('builtin_')) {
        try {
          const result = await executeBuiltinTool(call.name, this.normalizeToolArguments(call.arguments));
          executedResults.push({ callId: call.id, toolName: call.name, serverId: 'builtin', result });
        } catch (e: any) {
          executedResults.push({ callId: call.id, toolName: call.name, serverId: 'builtin', error: e.message });
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

  async analyzeConsoleError(params: {
    errorMessage: string;
    stackTrace?: any;
    requestId: string;
    sourceDirectory?: string;
    scripts?: Array<{ scriptId: string; url?: string }>;
    target?: { clientId?: string; sessionId?: number };
    onProgress?: (event: AIProgressEvent) => void;
  }): Promise<{ requestId: string; insight: string; sources?: string[] }> {
    const useCodexTools = this.isCodexProvider();
    this.reportDbg({
      hypothesisId: 'S4',
      msg: '[DEBUG] ai-service analyzeConsoleError received',
      location: 'main/ai-service.ts:625',
      data: {
        requestId: params.requestId,
        scriptsCount: Array.isArray(params.scripts) ? params.scripts.length : -1,
        scriptsPreview: Array.isArray(params.scripts) ? params.scripts.slice(0, 5) : undefined,
        target: params.target
      }
    });
    // Truncate error message
    let errorMessage = params.errorMessage;
    if (errorMessage.length > 2000) {
      errorMessage = errorMessage.substring(0, 2000) + `... [truncated, original: ${params.errorMessage.length} chars]`;
    }

    // Truncate stack trace
    let stackTraceStr = '';
    if (params.stackTrace) {
      stackTraceStr = JSON.stringify(params.stackTrace, null, 2);
      if (stackTraceStr.length > 1500) {
        stackTraceStr = stackTraceStr.substring(0, 1500) + `... [truncated]`;
      }
    }

    // Build user message
    let userMessage = `Analyze this console error:\n\n${errorMessage}`;
    if (stackTraceStr) {
      userMessage += `\n\nStack Trace:\n${stackTraceStr}`;
    }
    if (params.target?.clientId !== undefined || params.target?.sessionId !== undefined) {
      userMessage += `\n\nAuthoritative Target Context:\n${JSON.stringify(params.target, null, 2)}\nUse this exact target for all tool calls related to this error.`;
    }
    if (Array.isArray(params.scripts) && params.scripts.length > 0) {
      const scriptSummary = params.scripts.slice(0, 50);
      userMessage += `\n\nScripts already cached by DevTools Frontend for this target:\n${JSON.stringify(scriptSummary, null, 2)}\nPrefer these scripts first. Only call Debugger_listScripts if this cached list is insufficient.`;
    }
    if (useCodexTools) {
      userMessage += this.shouldUseCodexLiveDebugMcp()
        ? `\n\nLive Debug Guidance:\nNo host-side runtime console snapshot was preloaded for this request. Use the connected debug MCP tools to inspect live console messages, scripts, and runtime state when needed.`
        : `\n\nRuntime Debug Availability:\nLive Debug MCP inspection is temporarily disabled in the current Codex route. Base your answer on the provided target context, cached script list, mounted source, and LynxBase tools when available.`;
    } else {
      this.emitStatus(params.onProgress, 'Collecting runtime console context...');
      const consoleRuntimeContext = await this.gatherConsoleRuntimeContext(params.errorMessage, params.target);
      if (consoleRuntimeContext) {
        userMessage += `\n\nLive CDP Runtime Console Context:\n${JSON.stringify(consoleRuntimeContext, null, 2)}`;
        this.emitStatus(params.onProgress, 'Captured runtime console context from CDP.');
      }
    }
    this.reportDbg({
      hypothesisId: 'S5',
      msg: '[DEBUG] ai-service built console insight prompt context',
      location: 'main/ai-service.ts:659',
      data: {
        requestId: params.requestId,
        hasScriptsSection: Array.isArray(params.scripts) && params.scripts.length > 0,
        userMessagePreview: userMessage.slice(0, 800)
      }
    });

    // Gather source context if a source directory is mounted
    if (params.sourceDirectory) {
      if (useCodexTools) {
        userMessage += `\n\nMounted Source Directory:\n${params.sourceDirectory}\nInspect the local workspace directly when source validation is needed.`;
      } else {
        this.emitStatus(params.onProgress, 'Searching the mounted source directory...');
        const sourceContext = await this.gatherSourceContext(
          params.errorMessage,
          params.stackTrace,
          params.sourceDirectory
        );
        if (sourceContext) {
          userMessage += `\n\nRelevant Source Code (from mounted directory: ${params.sourceDirectory}):\n${sourceContext}`;
          this.emitStatus(params.onProgress, 'Matched local source snippets for this console error.');
        }
      }
    }

    // Get available tools
    let mcpTools: any[] = [];
    try {
      mcpTools = await this.mcpClientManager.listTools();
    } catch (e) {
      console.warn('Failed to list MCP tools for Console Insight:', e);
    }
    // Tool selection strategy:
    // - If a source directory is mounted: allow builtin_read_file/grep_source and optionally CDP tools
    // - If no source directory: prefer CDP tools; do NOT include builtin file tools to avoid ineffective calls
    const hasSourceDir = !!params.sourceDirectory;
    const includeCDP = !!params.target && (params.target.clientId !== undefined || params.target.sessionId !== undefined);
    const hasLynxBaseTools = mcpTools.some(tool => tool?.serverId === 'lynxbase-mcp');
    const filteredMcpTools = includeCDP ? mcpTools.filter(t => !String(t?.name || '').startsWith('Device_')) : mcpTools;
    // Narrow tool set to avoid unnecessary Device_* discovery when context is already known.
    // For Console Insight, once clientId/sessionId are available, only expose pure CDP tools.
    // This prevents the model from falling back to Device.listClients / Device.listSessions.
    const cdpOnlyTools = this.cdpTools.filter(t => this.getToolCategory(t.name) === 'cdp');
    const availableTools = hasSourceDir
      ? (includeCDP ? [...filteredMcpTools, ...this.builtinTools, ...cdpOnlyTools] : [...filteredMcpTools, ...this.builtinTools])
      : (includeCDP ? [...filteredMcpTools, ...cdpOnlyTools] : [...filteredMcpTools]);
    const arkTools = this.toArkTools(availableTools);

    let systemMessage = this.getConsoleInsightSystemPrompt();
    if (hasSourceDir) {
      systemMessage += `\n\nThe user has mounted a local source code directory at: ${params.sourceDirectory}
You can use builtin_read_file and builtin_grep_source tools to examine source files there.
Supported file types: ts, tsx, js, jsx, css, scss, ttjs, ttml, ttss.
When referencing source code, mention the file path and line number.`;
    }
    if (!hasSourceDir && includeCDP) {
      systemMessage += `\n\nNo local source directory is mounted. Prefer using CDP tools:
Use Runtime_listConsole to retrieve the console entry and its stack frames.
Use Debugger_listScripts to enumerate session scripts and map by URL.
Use Debugger_getScriptSource to fetch the script text by scriptId.
The provided clientId/sessionId is authoritative for this error. Do not query Device_listClients or Device_listSessions.
Do not attempt builtin_read_file or builtin_grep_source without a mounted source directory.`;
    } else if (includeCDP) {
      systemMessage += `\n\nThe provided clientId/sessionId is authoritative for this error. Do not query Device_listClients or Device_listSessions.`;
    }
    if (Array.isArray(params.scripts) && params.scripts.length > 0) {
      systemMessage += `\n\nA cached script list from DevTools Frontend is already included in the user context. Use that list first and avoid calling Debugger_listScripts unless the cached scripts are insufficient for this analysis.`;
    }
    if (useCodexTools && includeCDP && this.shouldUseCodexLiveDebugMcp()) {
      systemMessage += `\n\nPrefer calling the live Debug MCP tools directly for runtime evidence. Reach for list_console_messages, list_scripts, get_script_source, or send_cdp before giving a generic explanation.`;
    }
    if (useCodexTools && hasSourceDir) {
      systemMessage += `\n\nWhen you need source evidence, inspect the mounted workspace directly instead of waiting for host-side source snippets.`;
    }
    if (hasLynxBaseTools) {
      systemMessage += `\n\nLynx Base MCP tools are available. Use them when Lynx-specific runtime behavior, error semantics, or best practices matter.`;
    }

    if (useCodexTools) {
      const { requestedToolNames } = await this.buildRecommendedCodexToolPlan('console');
      const prompt = this.buildCodexAnalysisPrompt({
        systemMessage,
        userMessage,
        sourceDirectory: params.sourceDirectory,
        supplementalContext: undefined,
        responseMode: 'inline-console'
      });
      this.emitStatus(
        params.onProgress,
        this.shouldUseCodexLiveDebugMcp()
          ? 'Passing lightweight console context to Codex SDK. It can pull live debug evidence as needed.'
          : 'Passing console context to Codex SDK without local live debug tools.'
      );
      const insight = await this.runCodexPrompt(
        prompt,
        params.sourceDirectory,
        requestedToolNames || params.target
          ? {
              ...(requestedToolNames ? { requestedToolNames } : {}),
              ...(params.target ? { target: params.target } : {})
            }
          : undefined,
        params.onProgress
      );
      return { requestId: params.requestId, insight };
    }

    if (this.config.provider === 'ark') {
      return this.analyzeConsoleErrorArk({
        requestId: params.requestId,
        userMessage,
        systemMessage,
        arkTools,
        availableTools,
        target: params.target
      });
    }

    // Anthropic fallback - simple one-shot call
    if (!this.anthropicClient) {
      throw new Error('AI client not configured. Please set API key first.');
    }

    const response = await this.anthropicClient.messages.create({
      model: this.config.model!,
      max_tokens: 1000,
      system: systemMessage,
      messages: [{ role: 'user', content: userMessage }]
    });

    const insight = response.content[0]?.type === 'text' ? response.content[0].text : 'Unable to analyze this error.';
    return { requestId: params.requestId, insight };
  }

  async analyzeElementIssue(params: {
    requestId: string;
    question: string;
    nodeId: number;
    nodeSummary?: any;
    sourceEntry?: {
      sourceURL?: string;
      lineNumber?: number;
      columnNumber?: number;
    };
    repositoryUrl?: string;
    sourceDirectory?: string;
    target?: { clientId?: string; sessionId?: number };
    onProgress?: (event: AIProgressEvent) => void;
  }): Promise<{ requestId: string; insight: string; sources?: string[] }> {
    const trimmedQuestion = params.question.trim().slice(0, 1200);
    const sourceEntry = params.sourceEntry || params.nodeSummary?.sourceEntry;
    const useCodexTools = this.isCodexProvider();
    let runtimeContext: Record<string, any> | null = null;
    if (useCodexTools) {
      this.emitStatus(params.onProgress, 'Preparing lightweight element context for Codex SDK...');
    } else {
      this.emitStatus(params.onProgress, 'Collecting DOM and CSS context for the selected element...');
      runtimeContext = await this.gatherElementRuntimeContext(params.nodeId, params.target);
    }

    let userMessage =
      `Analyze the selected Lynx element and answer the user's question.\n\n` +
      `User Question:\n${trimmedQuestion}\n\n` +
      `Selected nodeId: ${params.nodeId}`;

    if (params.target?.clientId !== undefined || params.target?.sessionId !== undefined) {
      userMessage +=
        `\n\nAuthoritative Target Context:\n${JSON.stringify(params.target, null, 2)}\n` +
        `Use this exact target for any CDP inspection related to the selected element.`;
    }
    if (params.nodeSummary) {
      userMessage += `\n\nFrontend Selected Node Summary:\n${JSON.stringify(params.nodeSummary, null, 2)}`;
    }
    if (useCodexTools) {
      userMessage += this.shouldUseCodexLiveDebugMcp()
        ? `\n\nLive Debug Guidance:\nNo host-side DOM/CSS/layout snapshot was preloaded for this request. Use the connected debug MCP tools to inspect the live node, layout, styles, and text when needed.`
        : `\n\nRuntime Debug Availability:\nLive Debug MCP inspection is temporarily disabled in the current Codex route. Base your answer on the provided node summary, source entry, mounted source, and LynxBase tools when available.`;
    }
    if (runtimeContext) {
      userMessage += `\n\nLive CDP Runtime Element Context:\n${JSON.stringify(runtimeContext, null, 2)}`;
      this.emitStatus(params.onProgress, 'Captured runtime DOM and CSS details for the selected node.');
    }
    if (sourceEntry) {
      userMessage += `\n\nSource Entry:\n${JSON.stringify(sourceEntry, null, 2)}`;
    }
    if (params.repositoryUrl) {
      userMessage += `\n\nSource Repository URL:\n${params.repositoryUrl}`;
    }

    if (params.sourceDirectory) {
      if (useCodexTools) {
        userMessage += `\n\nMounted Source Directory:\n${params.sourceDirectory}\nInspect the local workspace directly when you need ownership or source evidence.`;
      } else {
        this.emitStatus(params.onProgress, 'Searching the mounted source for the selected element...');
        const sourceContext = await this.gatherElementSourceContext({
          question: trimmedQuestion,
          nodeSummary: params.nodeSummary,
          sourceEntry,
          sourceDirectory: params.sourceDirectory
        });
        if (sourceContext) {
          userMessage += `\n\nRelevant Source Code (from mounted directory: ${params.sourceDirectory}):\n${sourceContext}`;
          this.emitStatus(params.onProgress, 'Matched local source context for the selected element.');
        }
      }
    }

    let mcpTools: any[] = [];
    try {
      mcpTools = await this.mcpClientManager.listTools();
    } catch (e) {
      console.warn('Failed to list MCP tools for Elements Insight:', e);
    }

    const hasSourceDir = !!params.sourceDirectory;
    const includeCDP = !!params.target && (params.target.clientId !== undefined || params.target.sessionId !== undefined);
    const filteredMcpTools = includeCDP ? mcpTools.filter(t => !String(t?.name || '').startsWith('Device_')) : mcpTools;
    const cdpOnlyTools = this.cdpTools.filter(t => this.getToolCategory(t.name) === 'cdp');
    const availableTools = hasSourceDir
      ? (includeCDP ? [...filteredMcpTools, ...this.builtinTools, ...cdpOnlyTools] : [...filteredMcpTools, ...this.builtinTools])
      : (includeCDP ? [...filteredMcpTools, ...cdpOnlyTools] : [...filteredMcpTools]);
    const arkTools = this.toArkTools(availableTools);

    let systemMessage = this.getElementsInsightSystemPrompt();
    if (hasSourceDir) {
      systemMessage += `\n\nA local source directory is mounted at: ${params.sourceDirectory}
Use builtin_read_file and builtin_grep_source to verify the selected node's source ownership or nearby implementation when helpful.
Supported file types: ts, tsx, js, jsx, css, scss, ttjs, ttml, ttss.`;
    }
    if (includeCDP) {
      systemMessage += `\n\nThe provided clientId/sessionId is authoritative. Do not query Device_listClients or Device_listSessions.`;
    }
    const hasLynxBaseTools = filteredMcpTools.some(tool => tool.serverId === 'lynxbase-mcp');
    if (hasLynxBaseTools) {
      systemMessage += `\n\nLynx Base MCP tools are available. Use them when you need Lynx-specific layout, style precedence, renderer behavior, or best-practice guidance.`;
    }
    if (useCodexTools && includeCDP && this.shouldUseCodexLiveDebugMcp()) {
      systemMessage += `\n\nPrefer calling the live Debug MCP tools directly. Reach for get_node_layout_snapshot, describe_dom_node, get_computed_style, get_matched_styles, get_node_text, or send_cdp before relying on guesses.`;
    }
    if (useCodexTools && hasSourceDir) {
      systemMessage += `\n\nWhen you need source ownership evidence, inspect the mounted workspace directly instead of waiting for host-side source snippets.`;
    }
    if (params.repositoryUrl) {
      systemMessage += `\n\nA repository URL is supplied by the user. Treat it as a source ownership hint only; do not invent files or links that are not supported by the mounted source or source entry.`;
    }

    const sources = this.buildElementInsightSources({
      sourceDirectory: params.sourceDirectory,
      repositoryUrl: params.repositoryUrl,
      sourceEntry,
      runtimeContext,
      hasLynxBaseTools
    });

    if (useCodexTools) {
      const { requestedToolNames } = await this.buildRecommendedCodexToolPlan('elements');
      const prompt = this.buildCodexAnalysisPrompt({
        systemMessage,
        userMessage,
        sourceDirectory: params.sourceDirectory,
        supplementalContext: undefined,
        responseMode: 'inline-elements'
      });
      this.emitStatus(
        params.onProgress,
        this.shouldUseCodexLiveDebugMcp()
          ? 'Passing lightweight element context to Codex SDK. It can inspect the live node and source as needed.'
          : 'Passing element context to Codex SDK without local live debug tools.'
      );
      const insight = await this.runCodexPrompt(
        prompt,
        params.sourceDirectory,
        requestedToolNames || params.target
          ? {
              ...(requestedToolNames ? { requestedToolNames } : {}),
              ...(params.target ? { target: params.target } : {})
            }
          : undefined,
        params.onProgress
      );
      return { requestId: params.requestId, insight, sources };
    }

    if (this.config.provider === 'ark') {
      const result = await this.analyzeConsoleErrorArk({
        requestId: params.requestId,
        userMessage,
        systemMessage,
        arkTools,
        availableTools,
        target: params.target
      });
      return {
        requestId: params.requestId,
        insight: result.insight,
        sources
      };
    }

    if (!this.anthropicClient) {
      throw new Error('AI client not configured. Please set API key first.');
    }

    const response = await this.anthropicClient.messages.create({
      model: this.config.model!,
      max_tokens: 1000,
      system: systemMessage,
      messages: [{ role: 'user', content: userMessage }]
    });

    const insight = response.content[0]?.type === 'text' ? response.content[0].text : 'Unable to analyze this element.';
    return { requestId: params.requestId, insight, sources };
  }

  async applyElementChange(params: {
    requestId: string;
    question: string;
    nodeId: number;
    nodeSummary?: any;
    sourceEntry?: {
      sourceURL?: string;
      lineNumber?: number;
      columnNumber?: number;
    };
    repositoryUrl?: string;
    sourceDirectory?: string;
    target?: { clientId?: string; sessionId?: number };
    onProgress?: (event: AIProgressEvent) => void;
  }): Promise<{ requestId: string; insight: string; sources?: string[] }> {
    if (!params.sourceDirectory) {
      throw new Error('No mounted source directory is available. Attach local source first, then try Apply again.');
    }

    const trimmedQuestion = params.question.trim().slice(0, 1200);
    const sourceEntry = params.sourceEntry || params.nodeSummary?.sourceEntry;
    const { requestedToolNames, hasLynxBaseTools } = await this.buildRecommendedCodexToolPlan('apply');
    this.emitStatus(params.onProgress, 'Preparing lightweight writable context for Codex SDK...');

    let userMessage =
      `Apply a source change for the selected Lynx element.\n\n` +
      `Requested change:\n${trimmedQuestion}\n\n` +
      `Selected nodeId: ${params.nodeId}`;

    if (params.target?.clientId !== undefined || params.target?.sessionId !== undefined) {
      userMessage +=
        `\n\nAuthoritative Target Context:\n${JSON.stringify(params.target, null, 2)}\n` +
        `Use this exact target for any CDP inspection related to the selected element.`;
    }
    if (params.nodeSummary) {
      userMessage += `\n\nFrontend Selected Node Summary:\n${JSON.stringify(params.nodeSummary, null, 2)}`;
    }
    userMessage += this.shouldUseCodexLiveDebugMcp()
      ? `\n\nLive Debug Guidance:\nNo host-side DOM/CSS/source snapshot was preloaded for this edit request. Use the connected debug MCP tools and the mounted workspace directly when you need more evidence before editing.`
      : `\n\nRuntime Debug Availability:\nLive Debug MCP inspection is temporarily disabled in the current Codex route. Use the mounted workspace, source entry, selected node summary, and LynxBase tools when available before making an edit.`;
    if (sourceEntry) {
      userMessage += `\n\nSource Entry:\n${JSON.stringify(sourceEntry, null, 2)}`;
    }
    if (params.repositoryUrl) {
      userMessage += `\n\nSource Repository URL:\n${params.repositoryUrl}`;
    }

    const systemMessage = [
      'You are Codex SDK applying a source-code change for a selected element inside Lynx DevTool.',
      'You are running with workspace-write access to the mounted source directory.',
      'You must edit the mounted local source directly when you can identify the owning file with reasonable confidence.',
      'Prefer the smallest targeted source change that satisfies the request.',
      'Do not edit generated files, lockfiles, or unrelated files.',
      'If multiple files are plausible, inspect the workspace and choose the best ownership match using source entry, selector, styles, and nearby component structure.',
      this.shouldUseCodexLiveDebugMcp()
        ? 'Prefer calling live Debug MCP tools for runtime DOM/CSS/layout evidence instead of assuming the current state.'
        : 'Runtime Debug MCP tools are temporarily unavailable in this Codex route. Base edits on the mounted workspace, selected node summary, source entry, and LynxBase evidence instead of assuming hidden runtime state.',
      hasLynxBaseTools ? 'Lynx Base MCP tools are available. Use them when Lynx-specific behavior or style precedence matters.' : '',
      'If you cannot confidently identify the owning file, do not guess. Explain why no change was made.',
      'Your response will be checked against the mounted filesystem. Do not claim that a file changed unless you actually edited it.',
      'After the edit, return exactly this format:',
      '**Changed files**: [file paths or "None"]',
      '**What changed**: [brief summary]',
      '**Why this file**: [brief explanation grounded in the evidence]'
    ].join('\n');

    const prompt = this.buildPromptSections([
      {
        title: 'Role',
        content: 'You are Codex SDK acting as the writable source-editing engine for a selected Lynx element.'
      },
      {
        title: 'Operating Constraints',
        content: [
          'Modify the local mounted source workspace when the ownership is sufficiently clear.',
          'Keep the change minimal and directly relevant to the requested element update.',
          'Use source entry, mounted source hints, repository hints, and live MCP evidence together before editing.'
        ].join('\n')
      },
      {
        title: 'Assistant Instructions',
        content: systemMessage
      },
      {
        title: 'Mounted Source Directory',
        content: params.sourceDirectory
      },
      params.repositoryUrl
        ? {
            title: 'Repository Hint',
            content: params.repositoryUrl
          }
        : undefined,
      {
        title: 'Structured Apply Request',
        content: userMessage
      }
    ]);

    this.reportDbg({
      hypothesisId: 'EAPPLY',
      msg: '[DEBUG] applyElementChange prepared writable Codex request',
      location: 'main/ai-service.ts:applyElementChange',
      data: {
        requestId: params.requestId,
        nodeId: params.nodeId,
        sourceDirectory: params.sourceDirectory,
        repositoryUrl: params.repositoryUrl,
        requestedToolNames
      }
    });

    this.emitStatus(params.onProgress, 'Snapshotting the mounted source before applying changes...');
    const workspaceBefore = await this.snapshotSourceWorkspace(params.sourceDirectory);

    this.emitStatus(params.onProgress, 'Sending the writable source change request to Codex SDK...');
    const insight = await this.runCodexPrompt(
      prompt,
      params.sourceDirectory,
      {
        sandbox: this.resolveWritableCodexSandbox(),
        requestedToolNames,
        target: params.target
      },
      params.onProgress
    );
    this.emitStatus(params.onProgress, 'Verifying whether local source files changed...');
    const workspaceAfter = await this.snapshotSourceWorkspace(params.sourceDirectory);
    const changedFiles = this.diffSourceWorkspaceSnapshots(workspaceBefore, workspaceAfter);
    const declaredChangedFiles = this.parseChangedFilesFromInsight(insight, params.sourceDirectory);
    const sources = this.buildElementInsightSources({
      sourceDirectory: params.sourceDirectory,
      repositoryUrl: params.repositoryUrl,
      sourceEntry,
      runtimeContext: undefined,
      hasLynxBaseTools
    });

    const verifiedChangedFiles = changedFiles;

    if (verifiedChangedFiles.length === 0) {
      return {
        requestId: params.requestId,
        insight: [
          insight.trim(),
          '**Apply status**: No source files in the mounted workspace were modified.',
          'Codex returned guidance for this request, but no local edit was verified. Try checking the mounted source directory or make the requested style change more specific.'
        ].filter(Boolean).join('\n\n'),
        sources
      };
    }

    const applyStatus = declaredChangedFiles.length > 0 ?
      `**Apply status**: Verified local edits in ${verifiedChangedFiles.slice(0, 4).join(', ')}.` :
      `**Apply status**: Verified local edits in ${verifiedChangedFiles.slice(0, 4).join(', ')}. Codex changed local files even though it did not report them cleanly.`;
    const nextSources = [...(sources || []), `Applied source: ${verifiedChangedFiles.join(', ')}`];
    return {
      requestId: params.requestId,
      insight: [insight.trim(), applyStatus].filter(Boolean).join('\n\n'),
      sources: nextSources
    };
  }

  private async gatherSourceContext(
    errorMessage: string,
    stackTrace: any,
    sourceDirectory: string
  ): Promise<string | null> {
    const ALLOWED_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'css', 'scss', 'ttjs', 'ttml', 'ttss'];
    const MAX_SOURCE_CONTEXT = 4000;
    const snippets: string[] = [];

    try {
      // Extract file references from stack trace
      const fileRefs = this.extractFileReferences(stackTrace);

      // Try to find matching source files
      for (const ref of fileRefs.slice(0, 5)) {
        const baseName = ref.fileName.replace(/^.*[\\/]/, '');
        const ext = baseName.split('.').pop()?.toLowerCase() || '';

        // Skip non-source files
        if (!ALLOWED_EXTENSIONS.includes(ext)) continue;

        // Search for the file in the source directory
        try {
          const grepResult = await executeBuiltinTool('builtin_grep_source', {
            pattern: baseName.replace(/\.[^.]+$/, ''),
            directory: sourceDirectory,
            fileGlob: `*.{${ALLOWED_EXTENSIONS.join(',')}}`,
            maxResults: 3
          });

          if (grepResult.content && grepResult.content !== 'No matches found.') {
            // Find the actual file path from grep results
            const lines = grepResult.content.split('\n');
            for (const line of lines) {
              const fileMatch = line.match(/^(.+?):\d+:/);
              if (fileMatch) {
                const filePath = fileMatch[1];
                // Read a window around the referenced line
                const startLine = Math.max(1, (ref.lineNumber || 1) - 5);
                const endLine = (ref.lineNumber || 1) + 15;
                const readResult = await executeBuiltinTool('builtin_read_file', {
                  path: filePath,
                  startLine,
                  endLine
                });
                if (readResult.content) {
                  snippets.push(`--- ${filePath} (lines ${startLine}-${endLine}) ---\n${readResult.content}`);
                }
                break; // One match per reference is enough
              }
            }
          }
        } catch {
          // Skip on error, continue with other files
        }

        // Check total size
        if (snippets.join('\n\n').length > MAX_SOURCE_CONTEXT) break;
      }

      // Also try to grep for error-specific keywords in source
      if (snippets.length === 0) {
        // Extract meaningful keywords from the error message (first significant word/phrase)
        const keywords = errorMessage
          .replace(/[^a-zA-Z0-9_\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 4 && !/^(error|undefined|null|cannot|failed|unable|unexpected)$/i.test(w))
          .slice(0, 2);

        for (const keyword of keywords) {
          try {
            const grepResult = await executeBuiltinTool('builtin_grep_source', {
              pattern: keyword,
              directory: sourceDirectory,
              fileGlob: `*.{${ALLOWED_EXTENSIONS.join(',')}}`,
              maxResults: 5
            });
            if (grepResult.content && grepResult.content !== 'No matches found.') {
              snippets.push(`--- Search for "${keyword}" in source ---\n${grepResult.content}`);
              break;
            }
          } catch {
            // Skip
          }
        }
      }

      if (snippets.length === 0) return null;

      let context = snippets.join('\n\n');
      if (context.length > MAX_SOURCE_CONTEXT) {
        context = context.substring(0, MAX_SOURCE_CONTEXT) + '\n... [source context truncated]';
      }
      return context;
    } catch {
      return null;
    }
  }

  private async gatherElementRuntimeContext(
    nodeId: number,
    target?: { clientId?: string; sessionId?: number }
  ): Promise<Record<string, any> | null> {
    if (!this.cdpExecutor || !target?.clientId || target.sessionId === undefined) {
      return null;
    }

    const params = { clientId: target.clientId, sessionId: target.sessionId, nodeId };
    const run = (method: string, extra?: Record<string, any>) =>
      this.cdpExecutor!(method, { ...params, ...(extra || {}) }, 'CDP');

    const [describeNode, attributes, boxModel, innerText, computedStyle, matchedStyles] = await Promise.allSettled([
      run('DOM.describeNode', { depth: 2, pierce: true }),
      run('DOM.getAttributes'),
      run('DOM.getBoxModel'),
      run('DOM.innerText'),
      run('CSS.getComputedStyleForNode'),
      run('CSS.getMatchedStylesForNode')
    ]);

    const runtimeContext: Record<string, any> = {};

    if (describeNode.status === 'fulfilled' && describeNode.value?.node) {
      runtimeContext.domTree = this.summarizeDomNodeTree(describeNode.value.node, 2);
    }
    if (attributes.status === 'fulfilled') {
      const attrs = this.attributesArrayToObject(attributes.value?.attributes);
      if (Object.keys(attrs).length > 0) {
        runtimeContext.attributes = attrs;
      }
    }
    if (boxModel.status === 'fulfilled' && boxModel.value?.model) {
      runtimeContext.boxModel = this.summarizeBoxModel(boxModel.value.model);
    }
    if (innerText.status === 'fulfilled') {
      const text =
        innerText.value?.text ||
        innerText.value?.innerText ||
        (typeof innerText.value === 'string' ? innerText.value : '');
      if (typeof text === 'string' && text.trim()) {
        runtimeContext.innerText = text.trim().slice(0, 240);
      }
    }
    if (computedStyle.status === 'fulfilled') {
      const styleSummary = this.summarizeStyleEntries(computedStyle.value?.computedStyle || computedStyle.value);
      if (Object.keys(styleSummary).length > 0) {
        runtimeContext.computedStyle = styleSummary;
      }
    }
    if (matchedStyles.status === 'fulfilled') {
      const matchedSummary = this.summarizeMatchedStyleRules(matchedStyles.value);
      if (matchedSummary.length > 0) {
        runtimeContext.matchedRules = matchedSummary;
      }
    }

    return Object.keys(runtimeContext).length > 0 ? runtimeContext : null;
  }

  private async gatherConsoleRuntimeContext(
    errorMessage: string,
    target?: { clientId?: string; sessionId?: number }
  ): Promise<Record<string, any> | null> {
    if (!this.cdpExecutor || !target?.clientId || target.sessionId === undefined) {
      return null;
    }

    try {
      const response = await this.cdpExecutor(
        'Runtime.listConsole',
        {
          clientId: target.clientId,
          sessionId: target.sessionId,
          limit: 20,
          includeStackTraces: true,
          level: ['error', 'warning']
        },
        'CDP'
      );

      const items = Array.isArray(response?.messages)
        ? response.messages
        : Array.isArray(response?.result)
          ? response.result
          : Array.isArray(response)
            ? response
            : [];

      if (items.length === 0) {
        return null;
      }

      const loweredNeedle = errorMessage.toLowerCase();
      const relevantItems = items
        .filter((item: any) => {
          const text =
            String(item?.text || item?.message || item?.description || item?.value || '').toLowerCase();
          return loweredNeedle.length === 0 || text.includes(loweredNeedle.slice(0, 80));
        })
        .slice(0, 3);

      const candidates = relevantItems.length > 0 ? relevantItems : items.slice(-3);
      const summary = candidates.map((item: any) => ({
        level: item?.level,
        text: String(item?.text || item?.message || item?.description || item?.value || '').slice(0, 400),
        url: item?.url,
        lineNumber: item?.lineNumber,
        columnNumber: item?.columnNumber,
        stackTrace: item?.stackTrace || item?.stack || undefined
      }));

      return summary.length > 0 ? { recentConsoleMatches: summary } : null;
    } catch (error) {
      console.warn('Failed to gather console runtime context:', error);
      return null;
    }
  }

  private summarizeDomNodeTree(node: any, depth: number): Record<string, any> {
    const summary: Record<string, any> = {
      nodeId: node?.nodeId,
      nodeName: node?.nodeName,
      localName: node?.localName,
      nodeType: node?.nodeType,
      childNodeCount: node?.childNodeCount
    };

    const attributes = this.attributesArrayToObject(node?.attributes);
    if (Object.keys(attributes).length > 0) {
      summary.attributes = attributes;
    }
    if (typeof node?.nodeValue === 'string' && node.nodeValue.trim()) {
      summary.nodeValue = node.nodeValue.trim().slice(0, 160);
    }
    if (depth > 0 && Array.isArray(node?.children) && node.children.length > 0) {
      summary.children = node.children.slice(0, 6).map((child: any) => this.summarizeDomNodeTree(child, depth - 1));
    }
    return summary;
  }

  private attributesArrayToObject(attributes: any): Record<string, string> {
    if (!Array.isArray(attributes)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (let index = 0; index < attributes.length; index += 2) {
      const name = attributes[index];
      const value = attributes[index + 1];
      if (typeof name === 'string' && typeof value === 'string') {
        result[name] = value;
      }
    }
    return result;
  }

  private summarizeStyleEntries(source: any): Record<string, string> {
    const entries = Array.isArray(source)
      ? source
      : Array.isArray(source?.cssProperties)
        ? source.cssProperties
        : [];
    const preferredProperties = [
      'display',
      'position',
      'width',
      'height',
      'max-width',
      'max-height',
      'min-width',
      'min-height',
      'flex',
      'flex-direction',
      'justify-content',
      'align-items',
      'gap',
      'margin',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
      'padding',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'border',
      'border-width',
      'border-style',
      'border-color',
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
      'border-top-color',
      'border-right-color',
      'border-bottom-color',
      'border-left-color',
      'color',
      'font-size',
      'line-height',
      'background',
      'background-color',
      'opacity',
      'overflow',
      'overflow-x',
      'overflow-y',
      'z-index',
      'visibility',
      'transform',
      'top',
      'right',
      'bottom',
      'left'
    ];

    const summary: Record<string, string> = {};
    for (const propertyName of preferredProperties) {
      const entry = entries.find((item: any) => item?.name === propertyName && item?.value !== undefined && !item?.disabled);
      if (entry && typeof entry.value === 'string' && entry.value.trim()) {
        summary[propertyName] = entry.value.trim();
      }
    }

    if (Object.keys(summary).length > 0) {
      return summary;
    }

    for (const entry of entries.slice(0, 10)) {
      if (entry?.name && typeof entry.value === 'string' && !entry?.disabled) {
        summary[entry.name] = entry.value.trim();
      }
    }
    return summary;
  }

  private summarizeBoxModel(model: any): Record<string, any> {
    const output: Record<string, any> = {
      width: model?.width,
      height: model?.height
    };

    const appendQuad = (key: string, quad: any): void => {
      const summary = this.summarizeQuad(quad);
      if (summary) {
        output[key] = summary;
      }
    };

    appendQuad('contentBox', model?.content);
    appendQuad('paddingBox', model?.padding);
    appendQuad('borderBox', model?.border);
    appendQuad('marginBox', model?.margin);
    return output;
  }

  private summarizeQuad(quad: any): Record<string, number>|null {
    if (!Array.isArray(quad) || quad.length < 8) {
      return null;
    }

    const xs = [quad[0], quad[2], quad[4], quad[6]].filter((value): value is number => typeof value === 'number');
    const ys = [quad[1], quad[3], quad[5], quad[7]].filter((value): value is number => typeof value === 'number');
    if (xs.length === 0 || ys.length === 0) {
      return null;
    }

    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    };
  }

  private summarizeMatchedStyleRules(response: any): Array<Record<string, any>> {
    const matchedRules = Array.isArray(response?.matchedCSSRules) ? response.matchedCSSRules : [];
    return matchedRules.slice(0, 6).map((matchedRule: any) => {
      const rule = matchedRule?.rule || {};
      return {
        selector:
          rule?.selectorList?.text ||
          rule?.selectorText ||
          rule?.origin ||
          'unknown-selector',
        origin: rule?.origin,
        style: this.summarizeStyleEntries(rule?.style)
      };
    }).filter((rule: Record<string, any>) => Object.keys(rule.style || {}).length > 0 || rule.selector);
  }

  private async gatherElementSourceContext(params: {
    question: string;
    nodeSummary?: any;
    sourceEntry?: { sourceURL?: string; lineNumber?: number; columnNumber?: number };
    sourceDirectory: string;
  }): Promise<string | null> {
    this.reportDbg({
      hypothesisId: 'ESOURCE',
      msg: '[DEBUG] gatherElementSourceContext started',
      location: 'main/ai-service.ts:gatherElementSourceContext',
      data: {
        sourceDirectory: params.sourceDirectory,
        sourceURL: params.sourceEntry?.sourceURL,
        selector: params.nodeSummary?.selector,
        questionPreview: params.question.slice(0, 200)
      }
    });
    const snippets: string[] = [];
    const directSourceSnippet = await this.readSourceSnippetFromEntry(params.sourceDirectory, params.sourceEntry);
    if (directSourceSnippet) {
      snippets.push(directSourceSnippet);
      this.reportDbg({
        hypothesisId: 'ESOURCE',
        msg: '[DEBUG] gatherElementSourceContext hit direct source entry snippet',
        location: 'main/ai-service.ts:gatherElementSourceContext',
        data: {
          sourceDirectory: params.sourceDirectory,
          sourceURL: params.sourceEntry?.sourceURL
        }
      });
    }

    if (snippets.length === 0) {
      const keywords = this.extractElementSourceKeywords(params.question, params.nodeSummary);
      this.reportDbg({
        hypothesisId: 'ESOURCE',
        msg: '[DEBUG] gatherElementSourceContext falling back to keyword search',
        location: 'main/ai-service.ts:gatherElementSourceContext',
        data: {
          sourceDirectory: params.sourceDirectory,
          keywords
        }
      });
      for (const keyword of keywords.slice(0, 3)) {
        try {
          const grepResult = await executeBuiltinTool('builtin_grep_source', {
            pattern: keyword,
            directory: params.sourceDirectory,
            fileGlob: '*.{ts,tsx,js,jsx,css,scss,ttjs,ttml,ttss}',
            maxResults: 5
          });
          if (grepResult.content && grepResult.content !== 'No matches found.') {
            snippets.push(`--- Search for "${keyword}" in source ---\n${grepResult.content}`);
            this.reportDbg({
              hypothesisId: 'ESOURCE',
              msg: '[DEBUG] gatherElementSourceContext found keyword source matches',
              location: 'main/ai-service.ts:gatherElementSourceContext',
              data: {
                keyword,
                sourceDirectory: params.sourceDirectory,
                preview: String(grepResult.content).slice(0, 400)
              }
            });
            break;
          }
        } catch {
          // Skip noisy source-search failures.
        }
      }
    }

    if (snippets.length === 0) {
      this.reportDbg({
        hypothesisId: 'ESOURCE',
        msg: '[DEBUG] gatherElementSourceContext found no source matches',
        location: 'main/ai-service.ts:gatherElementSourceContext',
        data: {
          sourceDirectory: params.sourceDirectory,
          sourceURL: params.sourceEntry?.sourceURL
        }
      });
      return null;
    }

    const context = snippets.join('\n\n');
    this.reportDbg({
      hypothesisId: 'ESOURCE',
      msg: '[DEBUG] gatherElementSourceContext returning source context',
      location: 'main/ai-service.ts:gatherElementSourceContext',
      data: {
        sourceDirectory: params.sourceDirectory,
        snippetCount: snippets.length,
        contextLength: context.length
      }
    });
    return context.length > 4000 ? `${context.slice(0, 4000)}\n... [source context truncated]` : context;
  }

  private async readSourceSnippetFromEntry(
    sourceDirectory: string,
    sourceEntry?: { sourceURL?: string; lineNumber?: number; columnNumber?: number }
  ): Promise<string | null> {
    const sourceURL = sourceEntry?.sourceURL;
    if (!sourceURL || /^https?:\/\//i.test(sourceURL)) {
      this.reportDbg({
        hypothesisId: 'ESOURCE',
        msg: '[DEBUG] readSourceSnippetFromEntry skipped source entry lookup',
        location: 'main/ai-service.ts:readSourceSnippetFromEntry',
        data: {
          sourceDirectory,
          sourceURL
        }
      });
      return null;
    }

    const lineNumber = typeof sourceEntry?.lineNumber === 'number' ? sourceEntry.lineNumber : 1;
    const startLine = Math.max(1, lineNumber - 4);
    const endLine = lineNumber + 18;
    const basename = path.basename(sourceURL);
    const searchTerms = Array.from(new Set([
      basename.replace(/\.[^.]+$/, ''),
      basename
    ].filter(Boolean)));

    for (const term of searchTerms) {
      try {
        const grepResult = await executeBuiltinTool('builtin_grep_source', {
          pattern: term,
          directory: sourceDirectory,
          fileGlob: '*.{ts,tsx,js,jsx,css,scss,ttjs,ttml,ttss}',
          maxResults: 3
        });

        if (!grepResult.content || grepResult.content === 'No matches found.') {
          continue;
        }

        const line = grepResult.content.split('\n').find((item: string) => /^.+?:\d+:/.test(item));
        const filePath = line?.match(/^(.+?):\d+:/)?.[1];
        if (!filePath) {
          continue;
        }

        const readResult = await executeBuiltinTool('builtin_read_file', {
          path: filePath,
          startLine,
          endLine
        });
        if (readResult.content) {
          this.reportDbg({
            hypothesisId: 'ESOURCE',
            msg: '[DEBUG] readSourceSnippetFromEntry matched source file',
            location: 'main/ai-service.ts:readSourceSnippetFromEntry',
            data: {
              sourceDirectory,
              sourceURL,
              matchedFilePath: filePath,
              startLine,
              endLine
            }
          });
          return `--- ${filePath} (lines ${startLine}-${endLine}) ---\n${readResult.content}`;
        }
      } catch {
        // Ignore source entry lookup failures and fall back to keyword search.
      }
    }

    this.reportDbg({
      hypothesisId: 'ESOURCE',
      msg: '[DEBUG] readSourceSnippetFromEntry found no direct file match',
      location: 'main/ai-service.ts:readSourceSnippetFromEntry',
      data: {
        sourceDirectory,
        sourceURL,
        searchTerms
      }
    });
    return null;
  }

  private extractElementSourceKeywords(question: string, nodeSummary?: any): string[] {
    const keywords = new Set<string>();
    const pushKeyword = (value?: string) => {
      if (!value) {
        return;
      }
      const trimmed = value.trim();
      if (trimmed.length >= 3) {
        keywords.add(trimmed);
      }
    };

    const selector = typeof nodeSummary?.selector === 'string' ? nodeSummary.selector : '';
    pushKeyword(selector.replace(/[#.:[\]>+~]/g, ' ').split(/\s+/).find(Boolean));
    pushKeyword(typeof nodeSummary?.nodeName === 'string' ? nodeSummary.nodeName.toLowerCase() : '');
    if (nodeSummary?.attributes && typeof nodeSummary.attributes === 'object') {
      for (const key of ['id', 'class', 'name', 'lynx-test-tag', 'data-testid']) {
        pushKeyword(typeof nodeSummary.attributes[key] === 'string' ? nodeSummary.attributes[key] : '');
      }
    }

    question
      .replace(/[^a-zA-Z0-9_\s-]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 4)
      .slice(0, 5)
      .forEach(pushKeyword);

    return Array.from(keywords);
  }

  private buildElementInsightSources(args: {
    sourceDirectory?: string;
    repositoryUrl?: string;
    sourceEntry?: { sourceURL?: string; lineNumber?: number; columnNumber?: number };
    runtimeContext?: Record<string, any> | null;
    hasLynxBaseTools: boolean;
  }): string[] | undefined {
    const sources: string[] = [];
    if (args.sourceEntry?.sourceURL) {
      const line = typeof args.sourceEntry.lineNumber === 'number' ? `:${args.sourceEntry.lineNumber}` : '';
      sources.push(`Source entry: ${args.sourceEntry.sourceURL}${line}`);
    }
    if (args.sourceDirectory) {
      sources.push(`Mounted source: ${args.sourceDirectory}`);
    }
    if (args.repositoryUrl) {
      sources.push(`Repository: ${args.repositoryUrl}`);
    }
    if (args.runtimeContext) {
      sources.push('Runtime context: live CDP DOM + CSS snapshot');
    }
    if (args.hasLynxBaseTools) {
      sources.push('Knowledge: Lynx Base MCP');
    }
    return sources.length > 0 ? sources : undefined;
  }

  private async snapshotSourceWorkspace(sourceDirectory: string): Promise<Map<string, WorkspaceFileSnapshot>> {
    const snapshot = new Map<string, WorkspaceFileSnapshot>();
    const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.ttjs', '.ttml', '.ttss']);
    const skipDirectories = new Set([
      '.git',
      'node_modules',
      'dist',
      'build',
      'out',
      'coverage',
      '.next',
      'Pods',
      'DerivedData'
    ]);
    const pending: string[] = [sourceDirectory];

    while (pending.length > 0) {
      const currentDirectory = pending.pop();
      if (!currentDirectory) {
        continue;
      }

      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(currentDirectory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!skipDirectories.has(entry.name)) {
            pending.push(path.join(currentDirectory, entry.name));
          }
          continue;
        }

        if (!entry.isFile() || !allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }

        const absolutePath = path.join(currentDirectory, entry.name);
        try {
          const stats = await fs.promises.stat(absolutePath);
          snapshot.set(path.relative(sourceDirectory, absolutePath), {
            mtimeMs: stats.mtimeMs,
            size: stats.size
          });
        } catch {
          // Ignore transient stat failures while the workspace is changing.
        }
      }
    }

    return snapshot;
  }

  private diffSourceWorkspaceSnapshots(
    before: Map<string, WorkspaceFileSnapshot>,
    after: Map<string, WorkspaceFileSnapshot>
  ): string[] {
    const changedFiles = new Set<string>();
    const filePaths = new Set([...before.keys(), ...after.keys()]);

    for (const filePath of filePaths) {
      const previous = before.get(filePath);
      const next = after.get(filePath);
      if (!previous || !next) {
        changedFiles.add(filePath);
        continue;
      }
      if (previous.mtimeMs !== next.mtimeMs || previous.size !== next.size) {
        changedFiles.add(filePath);
      }
    }

    return Array.from(changedFiles).sort();
  }

  private parseChangedFilesFromInsight(insight: string, sourceDirectory: string): string[] {
    const normalizedInsight = insight || '';
    const match = normalizedInsight.match(/\*\*Changed files\*\*:\s*([^\n]+)/i);
    if (!match || !match[1]) {
      return [];
    }

    const rawValue = match[1].trim();
    if (!rawValue || /^none$/i.test(rawValue) || /^\["?none"?\]$/i.test(rawValue)) {
      return [];
    }

    const cleaned = rawValue.replace(/^\[/, '').replace(/\]$/, '');
    const parts = cleaned.split(/[,;]/).map(part => part.trim().replace(/^["'`]+|["'`]+$/g, '')).filter(Boolean);
    return Array.from(new Set(parts.map(part => {
      const absolutePath = path.isAbsolute(part) ? part : path.resolve(sourceDirectory, part);
      return path.relative(sourceDirectory, absolutePath);
    }))).sort();
  }

  private extractFileReferences(stackTrace: any): Array<{ fileName: string; lineNumber?: number }> {
    const refs: Array<{ fileName: string; lineNumber?: number }> = [];
    if (!stackTrace) return refs;

    const traceStr = typeof stackTrace === 'string' ? stackTrace : JSON.stringify(stackTrace);

    // Match common stack trace patterns: "at file.ts:42", "file.tsx:42:10", "(file.js:10:5)"
    const patterns = [
      /([a-zA-Z0-9_\-/.]+\.[a-zA-Z]+):(\d+)/g,
      /"url"\s*:\s*"([^"]+)"/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(traceStr)) !== null) {
        const fileName = match[1];
        const lineNumber = match[2] ? parseInt(match[2], 10) : undefined;
        // Skip obviously non-source files
        if (fileName.includes('node_modules') || fileName.startsWith('http')) continue;
        refs.push({ fileName, lineNumber });
      }
    }

    return refs;
  }

  private async analyzeConsoleErrorArk(args: {
    requestId: string;
    userMessage: string;
    systemMessage: string;
    arkTools: any[];
    availableTools: any[];
    target?: { clientId?: string; sessionId?: number };
  }): Promise<{ requestId: string; insight: string; sources?: string[] }> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error('Ark not configured.');
    }

    const url = this.getArkResponsesUrl();

    // Filter out tools with empty or invalid schemas to avoid Ark API validation errors
    const validTools = args.arkTools.filter(t => t && t.name && typeof t.name === 'string');

    const payload: any = {
      model: this.config.model,
      store: true,
      input: [
        { type: 'message', role: 'system', content: args.systemMessage },
        { type: 'message', role: 'user', content: args.userMessage }
      ]
    };

    // Only include tools if there are valid ones
    if (validTools.length > 0) {
      payload.tools = validTools;
    }

    try {
      const initialData = await this.postArk(url, payload);

      // If tools were included, run the tool loop
      if (validTools.length > 0) {
        // Use a self-contained tool loop that doesn't reference this.conversationHistory
        const { text } = await this.runInsightToolLoop({
          url,
          systemMessage: args.systemMessage,
          userMessage: args.userMessage,
          arkTools: validTools,
          availableTools: args.availableTools,
          initialData,
          maxRounds: 3,
          target: args.target
        });
        return {
          requestId: args.requestId,
          insight: text || 'Unable to analyze this error.'
        };
      }

      // No tools - just extract text from initial response
      const text = this.extractArkAssistantText(initialData);
      return {
        requestId: args.requestId,
        insight: text || 'Unable to analyze this error.'
      };
    } catch (err) {
      const axiosErr = err as AxiosError<any>;
      const errMsg = axiosErr?.response?.data?.error?.message || (err instanceof Error ? err.message : 'Unknown error');
      console.error('Ark Console Insight request failed:', errMsg, 'Status:', axiosErr?.response?.status);

      // Retry without tools if the error might be tool-related
      if (axiosErr?.response?.status === 400 && validTools.length > 0) {
        console.warn('Retrying without tools...');
        const retryPayload = {
          model: this.config.model,
          store: true,
          input: [
            { type: 'message', role: 'system', content: args.systemMessage },
            { type: 'message', role: 'user', content: args.userMessage }
          ]
        };
        const retryData = await this.postArk(url, retryPayload);
        const text = this.extractArkAssistantText(retryData);
        return {
          requestId: args.requestId,
          insight: text || 'Unable to analyze this error.'
        };
      }

      throw new Error(`Ark analysis failed: ${errMsg}`);
    }
  }

  private async runInsightToolLoop(args: {
    url: string;
    systemMessage: string;
    userMessage: string;
    arkTools: any[];
    availableTools: any[];
    initialData: any;
    maxRounds: number;
    target?: { clientId?: string; sessionId?: number };
  }): Promise<{ text: string }> {
    let currentData: any = args.initialData;
    let currentResponseId: string | undefined = (currentData as any)?.id;
    let text = this.extractArkAssistantText(currentData);

    for (let step = 0; step < args.maxRounds; step++) {
      const toolCalls = this.parseArkToolCalls(currentData, args.availableTools);
      if (toolCalls.length === 0) {
        break;
      }

      const executedResults = await this.executeToolCalls(toolCalls, args.availableTools, args.target);
      const resultsText = this.formatToolResultsText(executedResults);
      const canSendToolResults =
        typeof currentResponseId === 'string' &&
        currentResponseId.length > 0 &&
        executedResults.every(r => typeof r.callId === 'string' && r.callId.length > 0);

      let followupPayload: any;
      if (canSendToolResults) {
        followupPayload = {
          model: this.config.model!,
          store: true,
          tools: args.arkTools,
          previous_response_id: currentResponseId,
          input: executedResults.map(r => ({
            type: 'function_call_output',
            call_id: r.callId,
            output: r.error ? JSON.stringify({ error: r.error }) : JSON.stringify(r.result)
          }))
        };
      } else {
        // Fallback: include full context (self-contained, no conversationHistory reference)
        followupPayload = {
          model: this.config.model!,
          store: true,
          tools: args.arkTools,
          input: [
            { type: 'message', role: 'system', content: `${args.systemMessage}\n\nTool Results:\n${resultsText}` },
            { type: 'message', role: 'user', content: args.userMessage }
          ]
        };
      }

      try {
        currentData = await this.postArk(args.url, followupPayload);
      } catch (err) {
        // If followup fails with previous_response_id, retry with full context
        if (canSendToolResults) {
          const fallbackPayload = {
            model: this.config.model!,
            store: true,
            tools: args.arkTools,
            input: [
              { type: 'message', role: 'system', content: `${args.systemMessage}\n\nTool Results:\n${resultsText}` },
              { type: 'message', role: 'user', content: args.userMessage }
            ]
          };
          currentData = await this.postArk(args.url, fallbackPayload);
        } else {
          throw err;
        }
      }

      const newId = (currentData as any)?.id;
      if (typeof newId === 'string' && newId.length > 0) {
        currentResponseId = newId;
      }
      const followText = this.extractArkAssistantText(currentData);
      if (followText) {
        text = followText;
      }
    }

    return { text };
  }

  async getConversationHistory(): Promise<ChatMessage[]> {
    return [...this.conversationHistory];
  }

  async clearConversation(): Promise<void> {
    this.conversationHistory = [];
  }

  private resolveWritableCodexSandbox(): CodexSandboxMode {
    return this.config.codexSandbox === 'danger-full-access' ? 'danger-full-access' : 'workspace-write';
  }

  private async buildRecommendedCodexToolPlan(
    context: 'console' | 'elements' | 'apply' | 'chat',
    explicitToolNames?: string[]
  ): Promise<{ requestedToolNames?: string[]; hasLynxBaseTools: boolean }> {
    let availableTools: any[] = [];
    try {
      availableTools = await this.mcpClientManager.listTools();
    } catch (error) {
      console.warn('Failed to list MCP tools for Codex SDK tool planning:', error);
      return {
        requestedToolNames: explicitToolNames && explicitToolNames.length > 0 ? explicitToolNames : undefined,
        hasLynxBaseTools: false
      };
    }

    const hasLynxBaseTools = availableTools.some(tool => tool?.serverId === 'lynxbase-mcp');
    const availableNames = new Set(
      availableTools
        .map(tool => String(tool?.name || ''))
        .filter(Boolean)
    );

    if (explicitToolNames && explicitToolNames.length > 0) {
      const filteredExplicitNames = explicitToolNames.filter(name => availableNames.has(name));
      return {
        requestedToolNames: filteredExplicitNames.length > 0 ? filteredExplicitNames : undefined,
        hasLynxBaseTools
      };
    }

    const recommendedDebugToolsByContext: Record<'console' | 'elements' | 'apply' | 'chat', string[]> = {
      chat: [],
      console: ['get_active_target', 'list_console_messages', 'list_scripts', 'get_script_source', 'send_cdp'],
      elements: [
        'get_active_target',
        'describe_dom_node',
        'get_node_layout_snapshot',
        'get_node_box_model',
        'get_computed_style',
        'get_matched_styles',
        'get_node_text',
        'send_cdp'
      ],
      apply: [
        'get_active_target',
        'describe_dom_node',
        'get_node_layout_snapshot',
        'get_node_box_model',
        'get_computed_style',
        'get_matched_styles',
        'get_node_text',
        'list_scripts',
        'get_script_source',
        'send_cdp'
      ]
    };

    const recommendedToolNames = new Set<string>();
    const recommendedDebugTools = new Set(recommendedDebugToolsByContext[context]);
    const enableLocalDebugTools = this.shouldUseCodexLiveDebugMcp();

    for (const tool of availableTools) {
      const toolName = String(tool?.name || '');
      if (!toolName) {
        continue;
      }
      if (
        enableLocalDebugTools &&
        tool?.serverId === DEVTOOL_DEBUG_MCP_SERVER_ID &&
        recommendedDebugTools.has(toolName)
      ) {
        recommendedToolNames.add(toolName);
        continue;
      }
      if (tool?.serverId === 'lynxbase-mcp') {
        recommendedToolNames.add(toolName);
      }
    }

    return {
      requestedToolNames: recommendedToolNames.size > 0 ? Array.from(recommendedToolNames) : undefined,
      hasLynxBaseTools
    };
  }

  private async buildCodexMcpConfig(
    requestedToolNames?: string[],
    target?: { clientId?: string; sessionId?: number }
  ): Promise<Record<string, any> | undefined> {
    let servers: Array<{
      id: string;
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      status: string;
    }> = [];

    try {
      servers = (await this.mcpClientManager.listServers()).filter(
        (server: any) => server?.status === 'connected' && typeof server?.command === 'string' && server.command.trim()
      ) as any;
    } catch (error) {
      console.warn('Failed to list MCP servers for Codex SDK config:', error);
      return undefined;
    }

    if (servers.length === 0) {
      return undefined;
    }

    let enabledToolsByServer = new Map<string, string[]>();
    if (requestedToolNames && requestedToolNames.length > 0) {
      try {
        const availableTools = await this.mcpClientManager.listTools();
        const requested = new Set(requestedToolNames);
        enabledToolsByServer = availableTools.reduce((acc, tool) => {
          if (!requested.has(String(tool?.name || '')) || !tool?.serverId) {
            return acc;
          }
          const bucket = acc.get(tool.serverId) || [];
          bucket.push(String(tool.name));
          acc.set(tool.serverId, bucket);
          return acc;
        }, new Map<string, string[]>());
      } catch (error) {
        console.warn('Failed to list MCP tools for Codex SDK allow-listing:', error);
      }
    }

    const mcpServers: Record<string, any> = {};
    for (const server of servers) {
      if (server.id === DEVTOOL_DEBUG_MCP_SERVER_ID && !this.shouldUseCodexLiveDebugMcp()) {
        continue;
      }
      const enabledTools = enabledToolsByServer.get(server.id);
      if (requestedToolNames?.length && (!enabledTools || enabledTools.length === 0)) {
        continue;
      }

      const env =
        server.env && Object.keys(server.env).length > 0 ? { ...server.env } : {};
      if (server.id === DEVTOOL_DEBUG_MCP_SERVER_ID) {
        if (target?.clientId !== undefined) {
          env[DEVTOOL_DEBUG_MCP_BOUND_CLIENT_ID_ENV] = String(target.clientId);
        }
        if (target?.sessionId !== undefined) {
          env[DEVTOOL_DEBUG_MCP_BOUND_SESSION_ID_ENV] = String(target.sessionId);
        }
      }

      mcpServers[server.id] = {
        command: server.command,
        ...(Array.isArray(server.args) && server.args.length > 0 ? { args: server.args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(enabledTools && enabledTools.length > 0 ? { enabled_tools: enabledTools } : {}),
        startup_timeout_ms: server.id === DEVTOOL_DEBUG_MCP_SERVER_ID ? 15000 : 10000,
        tool_timeout_sec: server.id === DEVTOOL_DEBUG_MCP_SERVER_ID ? 90 : 60,
        required: server.id === DEVTOOL_DEBUG_MCP_SERVER_ID
      };
    }

    return Object.keys(mcpServers).length > 0 ? mcpServers : undefined;
  }

  private async runCodexPrompt(
    prompt: string,
    sourceDirectory?: string,
    overrides?: {
      sandbox?: CodexSandboxMode;
      requestedToolNames?: string[];
      target?: { clientId?: string; sessionId?: number };
    },
    onProgress?: (event: AIProgressEvent) => void
  ): Promise<string> {
    const cwd = sourceDirectory && fs.existsSync(sourceDirectory) ? sourceDirectory : process.cwd();
    const sandbox = overrides?.sandbox || this.config.codexSandbox;
    const mcpServers = await this.buildCodexMcpConfig(overrides?.requestedToolNames, overrides?.target);
    this.reportDbg({
      hypothesisId: 'ECODEX',
      msg: '[DEBUG] runCodexPrompt invoking Codex SDK',
      location: 'main/ai-service.ts:runCodexPrompt',
      data: {
        cwd,
        sourceDirectory,
        sandbox: sandbox || 'read-only',
        promptLength: prompt.length,
        mcpServerIds: mcpServers ? Object.keys(mcpServers) : [],
        target: overrides?.target
      }
    });
    this.emitStatus(onProgress, 'Starting Codex SDK...', 'codex', 'codex.sdk');
    const response = await this.codexSDKService.run(
      {
        prompt,
        cwd
      },
      {
        command: this.config.codexCommand,
        model: this.config.codexModel,
        profile: this.config.codexProfile,
        sandbox,
        config: mcpServers ? { mcp_servers: mcpServers } : undefined
      },
      {
        onProgress: (event: CodexSDKProgressEvent) => {
          this.emitProgress(onProgress, {
            phase: event.phase,
            source: 'codex',
            message: event.message,
            text: event.text,
            rawType: event.rawType
          });
        },
        onDebug: (event: CodexSDKDebugEvent) => {
          this.reportDbg({
            hypothesisId: 'ECODEX',
            msg: '[DEBUG] Codex SDK event',
            location: 'main/ai-service.ts:runCodexPrompt',
            data: event
          });
        }
      }
    );

    this.reportDbg({
      hypothesisId: 'ECODEX',
      msg: '[DEBUG] runCodexPrompt received Codex SDK output',
      location: 'main/ai-service.ts:runCodexPrompt',
      data: {
        cwd,
        sandbox: sandbox || 'read-only',
        outputLength: response.output.length,
        mcpServerIds: mcpServers ? Object.keys(mcpServers) : []
      }
    });

    return response.output || 'No response';
  }

  private buildCodexChatPrompt(args: {
    message: string;
    sourceDirectory?: string;
    debugContext?: any;
    toolContext?: string;
  }): string {
    return this.buildPromptSections([
      {
        title: 'Role',
        content:
          'You are Codex SDK acting as the reasoning engine inside the Lynx DevTool desktop AI assistant.'
      },
      {
        title: 'Operating Constraints',
        content: [
          'Do not modify files or claim that you changed code.',
          'If you inspect the local workspace, keep it read-only and use it only as supporting evidence.',
          'Use the provided debug context and mounted source hints as a starting point, not as the only evidence.',
          'If MCP tools are configured, prefer calling them directly during this turn when live evidence would help.',
          'Answer the latest user message directly.'
        ].join('\n')
      },
      {
        title: 'Assistant Instructions',
        content: this.getSystemPrompt()
      },
      args.sourceDirectory
        ? {
            title: 'Mounted Source Directory',
            content: args.sourceDirectory
          }
        : undefined,
      args.debugContext
        ? {
            title: 'Current Debug Context',
            content: this.stringifyForPrompt(args.debugContext, 12000)
          }
        : undefined,
      args.toolContext
        ? {
            title: 'Pre-fetched MCP Context',
            content: args.toolContext
          }
        : undefined,
      {
        title: 'Conversation So Far',
        content: this.formatConversationHistoryForPrompt(10, true)
      },
      {
        title: 'Latest User Message',
        content: args.message
      }
    ]);
  }

  private buildCodexAnalysisPrompt(args: {
    systemMessage: string;
    userMessage: string;
    sourceDirectory?: string;
    supplementalContext?: string;
    responseMode: 'inline-console' | 'inline-elements';
  }): string {
    const responseInstruction =
      args.responseMode === 'inline-console'
        ? 'Return only the inline console answer. Keep it concise and follow the requested response format exactly.'
        : 'Return only the inline elements answer. Keep it concise and follow the requested response format exactly.';

    return this.buildPromptSections([
      {
        title: 'Role',
        content:
          'You are Codex SDK acting as the reasoning engine for an inline diagnostic card inside Lynx DevTool.'
      },
      {
        title: 'Operating Constraints',
        content: [
          'Do not modify files or propose that you already made any code changes.',
          'Use the provided target, node, source, and repository hints as starting context.',
          this.shouldUseCodexLiveDebugMcp()
            ? 'If live MCP tools are available, prefer calling them directly instead of relying only on host-prefetched evidence.'
            : 'If live runtime tools are unavailable, rely on the provided context, mounted source, and any non-runtime MCP evidence instead of inventing missing state.',
          'When runtime, source, or MCP evidence is available, cite it explicitly in the response instead of giving a generic answer.',
          'If you inspect local files, keep it read-only and use them to confirm ownership or implementation details.',
          responseInstruction
        ].join('\n')
      },
      {
        title: 'Assistant Instructions',
        content: args.systemMessage
      },
      args.sourceDirectory
        ? {
            title: 'Mounted Source Directory',
            content: args.sourceDirectory
          }
        : undefined,
      args.supplementalContext
        ? {
            title: 'Pre-fetched MCP Context',
            content: args.supplementalContext
          }
        : undefined,
      {
        title: 'Structured Analysis Request',
        content: args.userMessage
      }
    ]);
  }

  private buildPromptSections(
    sections: Array<{ title: string; content: string } | undefined>
  ): string {
    return sections
      .filter((section): section is { title: string; content: string } => {
        return !!section && typeof section.content === 'string' && section.content.trim().length > 0;
      })
      .map(section => `## ${section.title}\n${section.content.trim()}`)
      .join('\n\n');
  }

  private formatConversationHistoryForPrompt(limit: number, omitLatestUserMessage?: boolean): string {
    let items = this.conversationHistory.filter(message => message.role !== 'system');
    if (omitLatestUserMessage && items[items.length - 1]?.role === 'user') {
      items = items.slice(0, -1);
    }
    items = items.slice(-limit);

    if (items.length === 0) {
      return 'No previous conversation.';
    }

    return items
      .map(message => {
        const role = message.role === 'assistant' ? 'Assistant' : 'User';
        return `${role}:\n${message.content}`;
      })
      .join('\n\n');
  }

  private stringifyForPrompt(value: any, maxLength: number): string {
    let content = '';
    try {
      content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    } catch {
      content = String(value);
    }

    if (content.length <= maxLength) {
      return content;
    }
    return `${content.slice(0, maxLength)}\n... [truncated ${content.length - maxLength} chars]`;
  }

  private async collectMCPContextForPrompt(args: {
    query: string;
    requestedToolNames?: string[];
    serverId?: string;
    limit?: number;
    toolContext?: PromptToolContext;
    toolFilter?: (tool: any) => boolean;
  }): Promise<{ text?: string; usedToolNames?: string[] }> {
    let availableTools: any[] = [];
    try {
      availableTools = await this.mcpClientManager.listTools();
    } catch (error) {
      console.warn('Failed to list MCP tools for Codex prompt context:', error);
      return {};
    }

    let candidateTools = availableTools;
    if (args.requestedToolNames?.length) {
      const requested = new Set(args.requestedToolNames);
      candidateTools = availableTools.filter(tool => requested.has(String(tool?.name || '')));
    } else if (args.serverId) {
      candidateTools = availableTools.filter(tool => tool?.serverId === args.serverId);
    }
    if (args.toolFilter) {
      candidateTools = candidateTools.filter(args.toolFilter);
    }

    const limit = Math.max(1, args.limit || candidateTools.length || 1);
    const rankedTools = [...candidateTools]
      .sort((left, right) => this.scoreMCPToolForPrompt(right, args.query) - this.scoreMCPToolForPrompt(left, args.query))
      .slice(0, Math.max(limit * 3, limit));

    const sections: string[] = [];
    const usedToolNames: string[] = [];

    for (const tool of rankedTools) {
      if (usedToolNames.length >= limit) {
        break;
      }

      const inferredArguments = this.inferMCPToolArguments(tool, args.query, args.toolContext);
      if (inferredArguments === null) {
        continue;
      }

      try {
        const result = await this.mcpClientManager.callTool(tool.serverId, tool.name, inferredArguments);
        sections.push(
          `Tool ${tool.name} (${tool.serverId}) input:\n${this.stringifyForPrompt(inferredArguments, 600)}\n\nResult:\n${this.stringifyForPrompt(result, 2400)}`
        );
        usedToolNames.push(String(tool.name));
      } catch (error) {
        sections.push(
          `Tool ${tool.name} (${tool.serverId}) failed:\n${error instanceof Error ? error.message : 'Unknown error'}`
        );
        usedToolNames.push(String(tool.name));
      }
    }

    return {
      text: sections.length > 0 ? sections.join('\n\n') : undefined,
      usedToolNames: usedToolNames.length > 0 ? usedToolNames : undefined
    };
  }

  private inferMCPToolArguments(tool: any, query: string, context?: PromptToolContext): Record<string, any> | null {
    const schema = tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
    const properties =
      schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const keywords = this.createMCPQueryKeywords(query);
    const output: Record<string, any> = {};

    const inferValue = (name: string, property: any): any => {
      if (property?.default !== undefined) {
        return property.default;
      }

      const type = Array.isArray(property?.type) ? property.type[0] : property?.type;
      const description =
        typeof property?.description === 'string' ? property.description.toLowerCase() : '';
      const label = `${name} ${description}`.toLowerCase();

      if (Array.isArray(property?.enum) && property.enum.length === 1) {
        return property.enum[0];
      }
      if (/(clientid|client id)/i.test(label) && context?.target?.clientId) {
        return context.target.clientId;
      }
      if (/(sessionid|session id)/i.test(label) && context?.target?.sessionId !== undefined) {
        return context.target.sessionId;
      }
      if (/(backendnodeid|backend node id)/i.test(label) && context?.backendNodeId !== undefined) {
        return context.backendNodeId;
      }
      if (/(nodeid|node id)/i.test(label) && context?.nodeId !== undefined) {
        return context.nodeId;
      }
      if (/(selector)/i.test(label) && typeof context?.nodeSummary?.selector === 'string') {
        return context.nodeSummary.selector;
      }
      if (/(sourceurl|source url|scripturl|script url|url)/i.test(label) && Array.isArray(context?.scripts)) {
        const firstUrl = context.scripts.find(script => typeof script?.url === 'string' && script.url)?.url;
        if (firstUrl) {
          return firstUrl;
        }
      }
      if (/(scriptid|script id)/i.test(label) && Array.isArray(context?.scripts)) {
        const firstScriptId = context.scripts.find(script => typeof script?.scriptId === 'string' && script.scriptId)?.scriptId;
        if (firstScriptId) {
          return firstScriptId;
        }
      }
      if (/(error|message)/i.test(label) && context?.errorMessage) {
        return context.errorMessage;
      }
      if (/(query|question|prompt|input|text|message|issue|problem|topic|search|keyword|keywords)/i.test(label)) {
        if (type === 'array') {
          return keywords;
        }
        return query;
      }
      if (type === 'array' && /(term|tag|keyword)/i.test(label)) {
        return keywords;
      }
      if ((type === 'integer' || type === 'number') && /(limit|count|top[_ -]?k|maxresults|max results)/i.test(label)) {
        return 3;
      }
      if (type === 'boolean' && /(include|with|enabled|enable|full|detailed|detail)/i.test(label)) {
        return true;
      }

      return undefined;
    };

    for (const requiredKey of required) {
      const property = properties[requiredKey];
      const inferredValue = inferValue(requiredKey, property);
      if (inferredValue === undefined) {
        return null;
      }
      output[requiredKey] = inferredValue;
    }

    for (const [name, property] of Object.entries<any>(properties)) {
      if (output[name] !== undefined) {
        continue;
      }
      const inferredValue = inferValue(name, property);
      if (inferredValue !== undefined) {
        output[name] = inferredValue;
      }
    }

    return output;
  }

  private createMCPQueryKeywords(query: string): string[] {
    const keywords = Array.from(
      new Set(
        query
          .toLowerCase()
          .replace(/[^a-z0-9_\s-]/g, ' ')
          .split(/\s+/)
          .filter(word => word.length >= 4)
      )
    );

    return keywords.slice(0, 8);
  }

  private scoreMCPToolForPrompt(tool: any, query: string): number {
    const haystack = `${tool?.name || ''} ${tool?.description || ''}`.toLowerCase();
    let score = tool?.serverId === 'lynxbase-mcp' ? 4 : 0;

    for (const keyword of this.createMCPQueryKeywords(query)) {
      if (haystack.includes(keyword)) {
        score += 2;
      }
    }

    if (/(search|query|explain|guide|style|layout|error|console|component|dom|css|runtime|debugger|cdp|script|source)/.test(haystack)) {
      score += 1;
    }

    return score;
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
        const inferredArguments = this.inferMCPToolArguments(tool, message);
        if (inferredArguments === null) {
          results.push({
            toolName: tool.name,
            serverId: tool.serverId,
            error: 'Tool schema is not suitable for automatic invocation'
          });
          continue;
        }

        const result = await this.mcpClientManager.callTool(
          tool.serverId, 
          tool.name, 
          inferredArguments
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

  private getConsoleInsightSystemPrompt(): string {
    return `You are an inline Console Insight assistant embedded in the Lynx DevTool Console panel.
Your task is to analyze console error messages from Lynx cross-platform applications and provide a concise, actionable explanation.

Format your response as:
**What happened**: [1-2 sentence explanation of the error]
**Runtime evidence**: [the strongest live console/script/source/MCP evidence you have, or say it is unavailable]
**Why**: [likely root cause]
**Fix**: [suggested fix or next debugging step]

Guidelines:
- Be concise. Your response appears inline below the error message, not in a chat window.
- Keep total response under 200 words.
- Use markdown formatting: **bold** for emphasis, \`code\` for identifiers and code snippets.
- Prefer live runtime evidence from the provided console entries, stack frames, script URLs, or source snippets over generic advice.
- If you have access to Lynx Base MCP tools, use them to look up Lynx-specific error codes, error messages, and best practices.
- If you have access to builtin_read_file or builtin_grep_source tools, use them to examine source code referenced in stack traces.
- If the error message references specific Lynx APIs or components, explain what they do.
- Do not ask follow-up questions. Provide your best analysis with the information available.
- If the error is a common JavaScript/TypeScript error (TypeError, ReferenceError, etc.), explain it in the context of Lynx development.`;
  }

  private getElementsInsightSystemPrompt(): string {
    return `You are an inline Elements Insight assistant embedded in the Lynx DevTool Elements panel.
Your task is to explain why a selected Lynx element behaves a certain way and recommend the best next debugging step.

Format your response as:
**Diagnosis**: [1-2 sentences about what is happening]
**Runtime evidence**: [the strongest live DOM/CSS/layout/source/MCP evidence you have, or say it is unavailable]
**Why**: [most likely cause, grounded in the provided DOM/CSS/source context]
**Best next step**: [the most useful fix or inspection step]

Guidelines:
- Keep total response under 260 words.
- Be specific. Prefer evidence from DOM tree structure, computed styles, matched rules, box model, source entry, and mounted source context.
- If the question is about layout, visibility, spacing, or style application, cite the live box model or computed style values directly when they are present.
- If Lynx Base MCP tools are available, use them for Lynx-specific layout, style precedence, renderer behavior, and best practices.
- If the selected node appears to map to source code, mention the source file path and line when helpful.
- If the question is about ownership, explain whether the evidence points to runtime styles, inherited styles, the source-mapped component, or missing source context.
- Do not ask follow-up questions. Provide your best answer with the available context.`;
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
