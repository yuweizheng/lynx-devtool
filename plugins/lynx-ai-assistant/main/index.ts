// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { definePlugin, MainContext } from '@lynx-js/devtool-plugin-core/main';
import { MCPClientManager } from './mcp-client-manager';
import { AIService } from './ai-service';
import { DebugContextCollector } from './debug-context-collector';

let _params: any;
let mcpClientManager: MCPClientManager;
let aiService: AIService;
let debugContextCollector: DebugContextCollector;

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
    return mcpClientManager.listTools(serverId);
  },

  // AI Chat
  async sendMessage(
    message: string,
    options?: {
      includeDebugContext?: boolean;
      mcpTools?: string[];
      target?: { clientId?: string; sessionId?: number };
    }
  ) {
    const context = options?.includeDebugContext ? await debugContextCollector.collectContext() : undefined;
    return aiService.sendMessage(message, { context, mcpTools: options?.mcpTools, target: options?.target });
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

  // Console Insights - one-shot error analysis
  async analyzeConsoleError(params: {
    errorMessage: string;
    stackTrace?: any;
    requestId: string;
  }) {
    // Auto-connect LynxBase MCP if not already connected
    try {
      const servers = mcpClientManager.listServers();
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
      // Continue without MCP - the analysis can still work with builtin tools
    }
    return aiService.analyzeConsoleError(params);
  },

  // AI Configuration
  async updateAIConfig(config: { apiKey?: string; model?: string; baseURL?: string }) {
    return aiService.updateConfig(config);
  },

  async getAIConfig() {
    return aiService.getConfig();
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
      return context.invokePluginEvent({
        eventName: 'EXECUTE_CDP_COMMAND',
        params: { method, params, type }
      });
    });
    debugContextCollector = new DebugContextCollector(context);

    // Set up auto-context collection
    debugContextCollector.startAutoCollection();
  },
  onRestart(context, params) {
    _params = params;
    
    // Restart services
    mcpClientManager?.cleanup();
    debugContextCollector?.stopAutoCollection();
    
    mcpClientManager = new MCPClientManager();
    aiService = new AIService(mcpClientManager, async (method, params, type = 'CDP') => {
      return context.invokePluginEvent({
        eventName: 'EXECUTE_CDP_COMMAND',
        params: { method, params, type }
      });
    });
    debugContextCollector = new DebugContextCollector(context);
    
    debugContextCollector.startAutoCollection();
  }
}); 
