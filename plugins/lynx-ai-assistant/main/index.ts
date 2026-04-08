// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { definePlugin, MainContext } from '@lynx-js/devtool-plugin-core/main';
import { MCPClientManager } from './mcp-client-manager';
import { AIProgressEvent, AIService } from './ai-service';
import { DebugContextCollector } from './debug-context-collector';
import { DevtoolDebugMCPProxy } from './devtool-debug-mcp-proxy';

let _params: any;
let mcpClientManager: MCPClientManager;
let aiService: AIService;
let debugContextCollector: DebugContextCollector;
let devtoolDebugMcpProxy: DevtoolDebugMCPProxy | null = null;
let mountedSourceDirectory: string | null = null;

const ensureLynxBaseMCPConnected = async () => {
  try {
    const servers = await mcpClientManager.listServers();
    const lynxbaseConnected = servers.some(
      (s: any) => s.name === 'Lynx Base MCP' && s.status === 'connected'
    );
    if (!lynxbaseConnected) {
      await mcpClientManager.connectServer({
        name: 'Lynx Base MCP',
        command: 'npx',
        args: ['-y', '--registry', 'https://bnpm.byted.org', '@byted-lynx/lynx-base-mcp-server@latest']
      });
    }
  } catch (e) {
    console.warn('Failed to auto-connect LynxBase MCP:', e);
  }
};

const ensureLocalDebugMCPConnected = async (context: MainContext) => {
  try {
    if (!devtoolDebugMcpProxy) {
      devtoolDebugMcpProxy = new DevtoolDebugMCPProxy(context, mcpClientManager, reportDbg);
    } else {
      devtoolDebugMcpProxy.setContext(context);
    }
    await devtoolDebugMcpProxy.ensureConnected();
  } catch (error) {
    console.warn('Failed to auto-connect local Lynx DevTool Debug MCP:', error);
  }
};

const reportDbg = (payload: Record<string, any>) => {
  try {
    const preview =
      payload && typeof payload === 'object'
        ? JSON.stringify(
            {
              hypothesisId: payload.hypothesisId ?? 'H?',
              msg: payload.msg ?? '[DEBUG] main-index',
              location: payload.location,
              data: payload.data
            },
            null,
            0
          )
        : String(payload);
    console.log('[AI dbg][main]', preview);
  } catch (_) {}
};

const publishAIStreamEvent = (
  context: MainContext,
  params: {
    channel: 'chat' | 'console' | 'elements';
    requestId: string;
  } & AIProgressEvent
) => {
  try {
    context.publishPluginEvent({
      eventName: 'LYNX_AI_STREAM_EVENT',
      params
    });
  } catch (error) {
    console.warn('[AI Assistant] Failed to publish AI stream event:', error);
  }
};

const bridge = (context: MainContext) => ({
  // MCP Management
  async listMCPServers() {
    return mcpClientManager.listServers();
  },

  async connectMCPServer(config: { name: string; command: string; args?: string[]; env?: Record<string, string> }) {
    return mcpClientManager.connectServer(config);
  },

  async disconnectMCPServer(serverId: string) {
    return mcpClientManager.disconnectServer(serverId);
  },

  async listMCPTools(serverId?: string) {
    await ensureLocalDebugMCPConnected(context);
    return mcpClientManager.listTools(serverId);
  },

  // AI Chat
  async sendMessage(
    message: string,
    options?: {
      includeDebugContext?: boolean;
      mcpTools?: string[];
      target?: { clientId?: string; sessionId?: number };
      requestId?: string;
    }
  ) {
    await ensureLocalDebugMCPConnected(context);
    const debugContext = options?.includeDebugContext ? await debugContextCollector.collectContext() : undefined;
    return aiService.sendMessage(message, {
      context: debugContext,
      mcpTools: options?.mcpTools,
      target: options?.target,
      sourceDirectory: mountedSourceDirectory || undefined,
      requestId: options?.requestId,
      onProgress: options?.requestId
        ? (event) => publishAIStreamEvent(context, {
            channel: 'chat',
            requestId: options.requestId!,
            ...event
          })
        : undefined
    });
  },

  async getConversationHistory() {
    return aiService.getConversationHistory();
  },

  async clearConversation() {
    return aiService.clearConversation();
  },

  // Debug Context
  async collectDebugContext() {
    return debugContextCollector.collectContext();
  },

  async getAvailableContextSources() {
    return debugContextCollector.getAvailableContextSources();
  },

  async setContextSourceEnabled(source: string, enabled: boolean) {
    return debugContextCollector.setContextSourceEnabled(source, enabled);
  },

  // Source Code Mounting
  async setSourceDirectory(path: string) {
    mountedSourceDirectory = path;
    return { success: true, path };
  },

  async getSourceDirectory() {
    return mountedSourceDirectory;
  },

  // Console Insights - one-shot error analysis
  async analyzeConsoleError(params: {
    errorMessage: string;
    stackTrace?: any;
    requestId: string;
    sourceDirectory?: string;
    scripts?: Array<{ scriptId: string; url?: string }>;
    target?: { clientId?: string; sessionId?: number };
  }) {
    await ensureLocalDebugMCPConnected(context);
    reportDbg({
      hypothesisId: 'S3',
      msg: '[DEBUG] main bridge analyzeConsoleError received',
      location: 'main/index.ts:105',
      data: {
        requestId: params.requestId,
        scriptsCount: Array.isArray(params.scripts) ? params.scripts.length : -1,
        scriptsPreview: Array.isArray(params.scripts) ? params.scripts.slice(0, 5) : undefined,
        target: params.target
      }
    });
    await ensureLynxBaseMCPConnected();
    // Use explicitly passed sourceDirectory, or fall back to session-level mounted dir
    const sourceDir = params.sourceDirectory || mountedSourceDirectory || undefined;
    return aiService.analyzeConsoleError({ 
      errorMessage: params.errorMessage,
      stackTrace: params.stackTrace,
      requestId: params.requestId,
      sourceDirectory: sourceDir,
      scripts: params.scripts,
      target: params.target,
      onProgress: (event) => publishAIStreamEvent(context, {
        channel: 'console',
        requestId: params.requestId,
        ...event
      })
    });
  },

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
  }) {
    await ensureLocalDebugMCPConnected(context);
    await ensureLynxBaseMCPConnected();
    const sourceDir = params.sourceDirectory || mountedSourceDirectory || undefined;
    return aiService.analyzeElementIssue({
      requestId: params.requestId,
      question: params.question,
      nodeId: params.nodeId,
      nodeSummary: params.nodeSummary,
      sourceEntry: params.sourceEntry,
      repositoryUrl: params.repositoryUrl,
      sourceDirectory: sourceDir,
      target: params.target,
      onProgress: (event) => publishAIStreamEvent(context, {
        channel: 'elements',
        requestId: params.requestId,
        ...event
      })
    });
  },

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
  }) {
    await ensureLocalDebugMCPConnected(context);
    await ensureLynxBaseMCPConnected();
    const sourceDir = params.sourceDirectory || mountedSourceDirectory || undefined;
    return aiService.applyElementChange({
      requestId: params.requestId,
      question: params.question,
      nodeId: params.nodeId,
      nodeSummary: params.nodeSummary,
      sourceEntry: params.sourceEntry,
      repositoryUrl: params.repositoryUrl,
      sourceDirectory: sourceDir,
      target: params.target,
      onProgress: (event) => publishAIStreamEvent(context, {
        channel: 'elements',
        requestId: params.requestId,
        ...event
      })
    });
  },

  // AI Configuration
  async updateAIConfig(config: {
    apiKey?: string;
    model?: string;
    baseURL?: string;
    provider?: 'anthropic' | 'openai' | 'custom' | 'ark' | 'codex-sdk' | 'codex-cli';
    codexCommand?: string;
    codexModel?: string;
    codexProfile?: string;
    codexSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  }) {
    return aiService.updateConfig(config);
  },

  async getAIConfig() {
    return aiService.getConfig();
  },

  async debugLog(payload: Record<string, any>) {
    reportDbg(payload);
    return { success: true };
  }
});

export type AIAssistantBridgeType = ReturnType<typeof bridge>;

export default definePlugin<AIAssistantBridgeType>({
  asyncBridge: bridge,
  onCreate(context, params) {
    _params = params;
    
    // Initialize services
    mcpClientManager = new MCPClientManager();
    aiService = new AIService(mcpClientManager, async (method, params, type = 'CDP') => {
      // #region debug-point D:main-executor-request
      reportDbg({
        hypothesisId: 'D',
        location: 'main/index.ts:149',
        msg: '[DEBUG] main cdpExecutor invoking plugin event',
        data: { method, type, params }
      });
      // #endregion
      const result = await context.invokePluginEvent({
        eventName: 'EXECUTE_CDP_COMMAND',
        params: { method, params, type }
      });
      // #region debug-point D:main-executor-response
      reportDbg({
        hypothesisId: 'D',
        location: 'main/index.ts:159',
        msg: '[DEBUG] main cdpExecutor received plugin event result',
        data: {
          method,
          type,
          resultType: typeof result,
          resultKeys: result && typeof result === 'object' ? Object.keys(result).slice(0, 10) : [],
          resultPreview: (() => {
            try {
              return JSON.stringify(result).slice(0, 500);
            } catch {
              return String(result);
            }
          })()
        }
      });
      // #endregion
      return result;
    });
    debugContextCollector = new DebugContextCollector(context);

    // Set up auto-context collection
    debugContextCollector.startAutoCollection();
    void ensureLocalDebugMCPConnected(context);
  },
  onRestart(context, params) {
    _params = params;
    
    // Restart services
    mcpClientManager?.cleanup();
    debugContextCollector?.stopAutoCollection();
    void devtoolDebugMcpProxy?.dispose();
    devtoolDebugMcpProxy = null;
    
    mcpClientManager = new MCPClientManager();
    aiService = new AIService(mcpClientManager, async (method, params, type = 'CDP') => {
      // #region debug-point D:main-executor-request
      reportDbg({
        hypothesisId: 'D',
        location: 'main/index.ts:186',
        msg: '[DEBUG] main cdpExecutor invoking plugin event',
        data: { method, type, params }
      });
      // #endregion
      const result = await context.invokePluginEvent({
        eventName: 'EXECUTE_CDP_COMMAND',
        params: { method, params, type }
      });
      // #region debug-point D:main-executor-response
      reportDbg({
        hypothesisId: 'D',
        location: 'main/index.ts:196',
        msg: '[DEBUG] main cdpExecutor received plugin event result',
        data: {
          method,
          type,
          resultType: typeof result,
          resultKeys: result && typeof result === 'object' ? Object.keys(result).slice(0, 10) : [],
          resultPreview: (() => {
            try {
              return JSON.stringify(result).slice(0, 500);
            } catch {
              return String(result);
            }
          })()
        }
      });
      // #endregion
      return result;
    });
    debugContextCollector = new DebugContextCollector(context);
    
    debugContextCollector.startAutoCollection();
    void ensureLocalDebugMCPConnected(context);
  }
}); 
