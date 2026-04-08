// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import React, { useState, useEffect, useRef } from 'react';
import { 
  Button, 
  Input, 
  Avatar, 
  Typography, 
  Space, 
  Spin, 
  message as antMessage,
  Tabs,
  Switch,
  List,
  Tag,
  Modal,
  Form,
  Select,
  Badge,
  Popconfirm
} from 'antd';
import { 
  SendOutlined, 
  RobotOutlined, 
  UserOutlined, 
  SettingOutlined,
  ToolOutlined,
  ClearOutlined,
  ReloadOutlined,
  BugOutlined,
  DeleteOutlined
} from '@ant-design/icons';
import { RendererContext } from '@lynx-js/devtool-plugin-core/renderer';
import { AIAssistantBridgeType } from '../../bridge';
import './AIAssistantView.scss';

const { TextArea } = Input;
const { Text, Title } = Typography;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  streaming?: boolean;
  statusText?: string;
  metadata?: {
    mcpToolsUsed?: string[];
    debugContext?: any;
  };
}

interface MCPServerInfo {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  error?: string;
  connectedAt?: Date;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: any;
  serverId: string;
}

interface ContextSource {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  category: 'device' | 'session' | 'network' | 'logs' | 'performance' | 'custom';
}

interface AIConfigView {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  provider?: 'anthropic' | 'openai' | 'custom' | 'ark' | 'codex-sdk' | 'codex-cli';
  codexCommand?: string;
  codexModel?: string;
  codexProfile?: string;
  codexSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

interface AIAssistantViewProps {
  context: RendererContext<AIAssistantBridgeType>;
}

interface AIStreamPayload {
  channel: 'chat' | 'console' | 'elements';
  requestId: string;
  phase: 'status' | 'delta' | 'snapshot' | 'error';
  source?: 'system' | 'codex';
  message?: string;
  text?: string;
  rawType?: string;
}

const normalizeAIProvider = (provider?: AIConfigView['provider']): NonNullable<AIConfigView['provider']> => {
  if (!provider || provider === 'codex-cli') {
    return 'codex-sdk';
  }
  return provider;
};

const isCodexProvider = (provider?: AIConfigView['provider']) => normalizeAIProvider(provider) === 'codex-sdk';

export const AIAssistantView: React.FC<AIAssistantViewProps> = ({ context }) => {
  const { asyncBridge } = context;
  
  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [includeDebugContext, setIncludeDebugContext] = useState(true);
  const [selectedMCPTools, setSelectedMCPTools] = useState<string[]>([]);
  const [isAIConfigured, setIsAIConfigured] = useState(false);
  const [aiProvider, setAIProvider] = useState<AIConfigView['provider']>('codex-sdk');
  
  // MCP state
  const [mcpServers, setMCPServers] = useState<MCPServerInfo[]>([]);
  const [mcpTools, setMCPTools] = useState<MCPTool[]>([]);
  const [contextSources, setContextSources] = useState<ContextSource[]>([]);
  
  // UI state
  const [activeTab, setActiveTab] = useState('chat');
  const [configModalVisible, setConfigModalVisible] = useState(false);
  const [addServerModalVisible, setAddServerModalVisible] = useState(false);
  const [editServerModalVisible, setEditServerModalVisible] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServerInfo | null>(null);
  const [connectingServers, setConnectingServers] = useState<Set<string>>(new Set());
  const [disconnectingServers, setDisconnectingServers] = useState<Set<string>>(new Set());
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [isEditingServer, setIsEditingServer] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const shouldStickChatToBottomRef = useRef(true);
  const inlineRequestTargetsRef = useRef<Map<string, {
    channel: 'console' | 'elements';
    source: Window;
  }>>(new Map());
  const [form] = Form.useForm();
  const [serverForm] = Form.useForm();
  const [editServerForm] = Form.useForm();
  const selectedProvider = normalizeAIProvider(Form.useWatch('provider', form) || aiProvider || 'codex-sdk');

  // Predefined MCP server templates
  const mcpServerTemplates = [
    {
      name: 'Filesystem MCP',
      command: 'npx',
      args: '-y @modelcontextprotocol/server-filesystem /tmp'
    },
    {
      name: 'Brave Search MCP',
      command: 'npx',
      args: '-y @modelcontextprotocol/server-brave-search'
    },
    {
      name: 'SQLite MCP',
      command: 'npx',
      args: '-y @modelcontextprotocol/server-sqlite'
    },
    {
      name: 'GitHub MCP',
      command: 'npx',
      args: '-y @modelcontextprotocol/server-github'
    }
  ];

  const applyServerTemplate = (template: typeof mcpServerTemplates[0]) => {
    serverForm.setFieldsValue({
      name: template.name,
      command: template.command,
      args: template.args
    });
  };

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  useEffect(() => {
    if (shouldStickChatToBottomRef.current) {
      scrollToBottom(messages.length > 8 ? 'auto' : 'smooth');
    }
  }, [messages]);

  const handleChatMessagesScroll = () => {
    const container = chatMessagesRef.current;
    if (!container) {
      return;
    }
    const bottomOffset = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickChatToBottomRef.current = bottomOffset < 32;
  };

  const stateRef = useRef({ includeDebugContext, selectedMCPTools, isLoading });
  useEffect(() => {
      stateRef.current = { includeDebugContext, selectedMCPTools, isLoading };
  }, [includeDebugContext, selectedMCPTools, isLoading]);

  useEffect(() => {
    const handleStreamEvent = (event: { params?: AIStreamPayload }) => {
      const payload = event?.params;
      if (!payload?.requestId || !payload?.channel) {
        return;
      }

      if (payload.channel === 'chat') {
        updateStreamingAssistantMessage(payload);
        return;
      }

      const target = inlineRequestTargetsRef.current.get(payload.requestId);
      if (!target || target.channel !== payload.channel) {
        return;
      }

      target.source?.postMessage({
        type: payload.channel === 'elements' ? 'lynx-elements-insight-response' : 'lynx-console-insight-response',
        content: {
          requestId: payload.requestId,
          status: 'progress',
          phase: payload.phase,
          message: payload.message,
          text: payload.text,
          rawType: payload.rawType
        }
      }, '*');
    };

    context.addPluginEventListener('LYNX_AI_STREAM_EVENT', handleStreamEvent);
    return () => {
      context.removePluginEventListener('LYNX_AI_STREAM_EVENT', handleStreamEvent);
    };
  }, [context]);

  const syncAIConfigState = (config?: AIConfigView) => {
    const provider = normalizeAIProvider(config?.provider);
    const ready = isCodexProvider(provider) ? true : !!config?.apiKey;
    setAIProvider(provider);
    setIsAIConfigured(ready);
  };

  const createRequestId = (prefix: string) =>
    `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const updateStreamingAssistantMessage = (payload: AIStreamPayload) => {
    setMessages(prev => {
      const next = [...prev];
      const existingIndex = next.findIndex(message => message.id === payload.requestId && message.role === 'assistant');
      const baseMessage: ChatMessage = existingIndex >= 0 ? next[existingIndex] : {
        id: payload.requestId,
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        streaming: true
      };

      const updatedMessage: ChatMessage = {
        ...baseMessage,
        streaming: payload.phase !== 'error'
      };

      if (payload.phase === 'status') {
        updatedMessage.statusText = payload.message || updatedMessage.statusText;
      } else if (payload.phase === 'delta' && typeof payload.text === 'string') {
        updatedMessage.content = `${baseMessage.content || ''}${payload.text}`;
      } else if (payload.phase === 'snapshot' && typeof payload.text === 'string') {
        updatedMessage.content = payload.text;
      } else if (payload.phase === 'error') {
        updatedMessage.statusText = payload.message || 'Codex reported an error.';
      }

      if (existingIndex >= 0) {
        next[existingIndex] = updatedMessage;
      } else {
        next.push(updatedMessage);
      }

      return next;
    });
  };

  const runChatRequest = async (
    userText: string,
    bridgeOptions?: {
      includeDebugContext?: boolean;
      mcpTools?: string[];
      target?: { clientId?: string; sessionId?: number };
    }
  ) => {
    const trimmedMessage = userText.trim();
    if (!trimmedMessage || isLoading) {
      return;
    }

    const requestId = createRequestId('chat');
    const now = new Date();
    shouldStickChatToBottomRef.current = true;
    setMessages(prev => [
      ...prev,
      {
        id: `user_${requestId}`,
        role: 'user',
        content: trimmedMessage,
        timestamp: now
      },
      {
        id: requestId,
        role: 'assistant',
        content: '',
        timestamp: now,
        streaming: true,
        statusText: 'Preparing Codex request...'
      }
    ]);
    setIsLoading(true);

    try {
      const response = await asyncBridge.sendMessage(trimmedMessage, {
        ...bridgeOptions,
        requestId
      });
      try {
        const history = await asyncBridge.getConversationHistory();
        setMessages(history);
      } catch {
        setMessages(prev => prev.map(message =>
          message.id === requestId
            ? {
                ...response,
                timestamp: new Date(response.timestamp),
                streaming: false,
                statusText: undefined
              }
            : message
        ));
      }
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
      setMessages(prev => prev.map(message =>
        message.id === requestId
          ? {
              ...message,
              content: message.content || errorMessage,
              streaming: false,
              statusText: errorMessage
            }
          : message
      ));
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const getChatPlaceholder = () => {
    if (isAIConfigured) {
      return 'Ask about debugging issues, errors, or anything related to your app...';
    }
    if (isCodexProvider(aiProvider)) {
      return 'Open Settings to confirm the Codex SDK provider configuration.';
    }
    return 'Please configure your AI provider in Settings first';
  };

  const ensureLynxBaseConnected = async () => {
    const result = await asyncBridge.connectMCPServer({
      name: 'Lynx Base MCP',
      command: 'npx',
      args: ['-y', '--registry', 'https://bnpm.byted.org', '@byted-lynx/lynx-base-mcp-server@latest']
    });
    if (result && result.success === false && result.error) {
      antMessage.warning(`Failed to connect Lynx Base MCP: ${result.error}`);
    }
  };

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      // Handle source directory attach request
      if (event.data?.type === 'lynx-attach-source-request') {
        const source = event.source as Window;
        try {
          const result = await (window as any).ldtElectronAPI?.invoke('select-directory');
          const { data } = result || {};
          if (data && !data.canceled && data.path) {
            await asyncBridge.setSourceDirectory(data.path);
            source?.postMessage({
              type: 'lynx-attach-source-response',
              content: { path: data.path, canceled: false }
            }, '*');
          } else {
            source?.postMessage({
              type: 'lynx-attach-source-response',
              content: { canceled: true }
            }, '*');
          }
        } catch (error) {
          console.error('Failed to select directory:', error);
          source?.postMessage({
            type: 'lynx-attach-source-response',
            content: { canceled: true }
          }, '*');
        }
        return;
      }

      if (event.data?.type === 'lynx-console-insight-debug') {
        const { requestId, stage, scriptsCount, scriptsPreview } = event.data.content || {};
        await asyncBridge.debugLog({
          hypothesisId: 'S1',
          msg: '[DEBUG] console scripts payload stage',
          location: 'renderer/components/AIAssistantView.tsx:190',
          data: { requestId, stage, scriptsCount, scriptsPreview }
        });
        return;
      }

      // Handle Console Insight requests (inline analysis, separate from chat)
      if (event.data?.type === 'lynx-console-insight-request') {
        const { requestId, errorMessage, stackTrace, sourceDirectory, target, scripts } = event.data.content;
        const source = event.source as Window;

        setIsLoading(true);
        inlineRequestTargetsRef.current.set(requestId, { channel: 'console', source });
        try {
          await asyncBridge.debugLog({
            hypothesisId: 'S2',
            msg: '[DEBUG] renderer received console insight request',
            location: 'renderer/components/AIAssistantView.tsx:201',
            data: {
              requestId,
              scriptsCount: Array.isArray(scripts) ? scripts.length : -1,
              scriptsPreview: Array.isArray(scripts) ? scripts.slice(0, 5) : undefined
            }
          });
          const selectedClientId = context.debugDriver.getSelectClientId?.();
          const selectedSessionId = context.debugDriver.getSelectSessionId?.();
          const result = await asyncBridge.analyzeConsoleError({
            requestId,
            errorMessage,
            stackTrace,
            sourceDirectory,
            scripts: Array.isArray(scripts) ? scripts : undefined,
            target: {
              clientId: selectedClientId !== undefined
                ? String(selectedClientId)
                : typeof target?.clientId === 'string'
                  ? target.clientId
                  : undefined,
              sessionId: typeof selectedSessionId === 'number'
                ? selectedSessionId
                : typeof target?.sessionId === 'number'
                  ? target.sessionId
                  : undefined
            }
          });
          source?.postMessage({
            type: 'lynx-console-insight-response',
            content: {
              requestId,
              status: 'done',
              insight: result.insight,
              sources: result.sources
            }
          }, '*');
        } catch (error) {
          source?.postMessage({
            type: 'lynx-console-insight-response',
            content: {
              requestId,
              status: 'error',
              error: error instanceof Error ? error.message : 'Analysis failed'
            }
          }, '*');
        } finally {
          inlineRequestTargetsRef.current.delete(requestId);
          setIsLoading(false);
        }
        return;
      }

      if (event.data?.type === 'lynx-elements-insight-request') {
        const source = event.source as Window;
        const { requestId, mode, question, nodeId, nodeSummary, sourceEntry, repositoryUrl, sourceDirectory, target } =
          event.data.content || {};
        const { isLoading } = stateRef.current;
        if (isLoading) {
          source?.postMessage({
            type: 'lynx-elements-insight-response',
            content: {
              requestId,
              nodeId,
              status: 'error',
              error: 'AI is busy processing another request'
            }
          }, '*');
          return;
        }

        setIsLoading(true);
        inlineRequestTargetsRef.current.set(requestId, { channel: 'elements', source });
        try {
          await ensureLynxBaseConnected();
          const selectedClientId = context.debugDriver.getSelectClientId?.();
          const selectedSessionId = context.debugDriver.getSelectSessionId?.();
          const requestPayload = {
            requestId,
            question,
            nodeId,
            nodeSummary,
            sourceEntry,
            repositoryUrl,
            sourceDirectory,
            target: {
              clientId: selectedClientId !== undefined
                ? String(selectedClientId)
                : typeof target?.clientId === 'string'
                  ? target.clientId
                  : undefined,
              sessionId: typeof selectedSessionId === 'number'
                ? selectedSessionId
                : typeof target?.sessionId === 'number'
                  ? target.sessionId
                  : undefined
            }
          };
          const result = mode === 'apply'
            ? await asyncBridge.applyElementChange(requestPayload)
            : await asyncBridge.analyzeElementIssue(requestPayload);
          source?.postMessage({
            type: 'lynx-elements-insight-response',
            content: {
              requestId,
              nodeId,
              status: 'done',
              insight: result.insight,
              sources: result.sources
            }
          }, '*');
        } catch (error) {
          source?.postMessage({
            type: 'lynx-elements-insight-response',
            content: {
              requestId,
              nodeId,
              status: 'error',
              error: error instanceof Error ? error.message : 'Element analysis failed'
            }
          }, '*');
        } finally {
          inlineRequestTargetsRef.current.delete(requestId);
          setIsLoading(false);
        }
        return;
      }

      if (event.data && (event.data.type === 'lynx-ai-analysis-request' || event.data.type === 'lynx-ai-elements-request')) {
        const { includeDebugContext, selectedMCPTools, isLoading } = stateRef.current;
        if (isLoading) {
            antMessage.warning('AI is busy processing another request');
            return;
        }

        const clientId = context.debugDriver.getSelectClientId?.();
        const sessionId = context.debugDriver.getSelectSessionId?.();

        let prompt = '';
        if (event.data.type === 'lynx-ai-analysis-request') {
          const { message, stackTrace } = event.data.content;
          prompt = `Please analyze the following error:\n${message}\n`;
          if (stackTrace) {
            prompt += `\nStack Trace:\n${JSON.stringify(stackTrace, null, 2)}`;
          }
        } else {
          const { question, nodeId } = event.data.content;
          prompt =
            `You are helping debug styles/layout in Lynx DevTool.\n` +
            `Selected Node:\n${JSON.stringify({ nodeId }, null, 2)}\n\n` +
            `User Question:\n${question}\n\n` +
            `If user asks to change the selected node style to red, you can set inline style via DOM.setAttributeValue (attribute name: "style").\n` +
            `For diagnosis, use CSS/DOM read tools (matched styles, computed styles, inline styles, stylesheet text) scoped to the selected nodeId.\n` +
            `Also use Lynx Base MCP tools for Lynx-specific fundamentals (layout, style precedence, runtime behavior, best practices).`;
        }

        if (clientId !== undefined || sessionId !== undefined) {
          prompt += `\n\nTarget Context:\n${JSON.stringify({ clientId, sessionId }, null, 2)}`;
        }
        
        setActiveTab('chat');
        
        try {
            if (event.data.type === 'lynx-ai-elements-request') {
              await ensureLynxBaseConnected();
            }
            await runChatRequest(prompt, {
              includeDebugContext,
              mcpTools: selectedMCPTools,
              target: {
                clientId: clientId !== undefined ? String(clientId) : undefined,
                sessionId: typeof sessionId === 'number' ? sessionId : undefined
              }
            });
        } catch (error) {
             console.error('Failed to analyze error:', error);
             antMessage.error('Failed to analyze error');
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [asyncBridge, context]);

  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    try {
      const [serversData, toolsData, sourcesData, historyData, aiConfig] = await Promise.all([
        asyncBridge.listMCPServers(),
        asyncBridge.listMCPTools(),
        asyncBridge.getAvailableContextSources(),
        asyncBridge.getConversationHistory(),
        asyncBridge.getAIConfig()
      ]);
      
      setMCPServers(serversData);
      setMCPTools(toolsData);
      setContextSources(sourcesData);
      setMessages(historyData);
      syncAIConfigState(aiConfig);
    } catch (error) {
      console.error('Failed to load initial data:', error);
      antMessage.error('Failed to initialize AI Assistant');
    }
  };

  const sendMessage = async () => {
    if (!inputMessage.trim() || isLoading) return;

    const userMessage = inputMessage.trim();
    setInputMessage('');

    try {
      await runChatRequest(userMessage, {
        includeDebugContext,
        mcpTools: selectedMCPTools
      });
    } catch (error) {
      console.error('Failed to send message:', error);
      antMessage.error('Failed to send message');
    }
  };

  const clearConversation = async () => {
    try {
      await asyncBridge.clearConversation();
      setMessages([]);
      antMessage.success('Conversation cleared');
    } catch (error) {
      console.error('Failed to clear conversation:', error);
      antMessage.error('Failed to clear conversation');
    }
  };

  const connectMCPServer = async (values: any) => {
    // 防止重复添加
    if (isAddingServer) {
      return;
    }
    
    setIsAddingServer(true);
    
    try {
      const result = await asyncBridge.connectMCPServer({
        name: values.name,
        command: values.command,
        args: values.args ? values.args.split(' ') : undefined
      });

      if (result.success) {
        antMessage.success(`Connected to ${values.name}`);
        loadInitialData();
        setAddServerModalVisible(false);
        serverForm.resetFields();
      } else {
        antMessage.error(result.error || 'Failed to connect');
      }
    } catch (error) {
      console.error('Failed to connect MCP server:', error);
      antMessage.error('Failed to connect MCP server');
    } finally {
      setIsAddingServer(false);
    }
  };

  const disconnectMCPServer = async (serverId: string) => {
    // 防止重复断开连接
    if (disconnectingServers.has(serverId)) {
      return;
    }
    
    setDisconnectingServers(prev => new Set(prev).add(serverId));
    
    try {
      const result = await asyncBridge.disconnectMCPServer(serverId);
      if (result.success) {
        antMessage.success('Disconnected from MCP server');
        loadInitialData();
      } else {
        antMessage.error(result.error || 'Failed to disconnect');
      }
    } catch (error) {
      console.error('Failed to disconnect MCP server:', error);
      antMessage.error('Failed to disconnect MCP server');
    } finally {
      setDisconnectingServers(prev => {
        const newSet = new Set(prev);
        newSet.delete(serverId);
        return newSet;
      });
    }
  };

  const reconnectMCPServer = async (server: MCPServerInfo) => {
    // 防止重复连接
    if (connectingServers.has(server.id) || server.status === 'connecting') {
      return;
    }
    
    setConnectingServers(prev => new Set(prev).add(server.id));
    
    try {
      // Use the updated connectServer method which will reuse the existing server ID
      const result = await asyncBridge.connectMCPServer({
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env
      });

      if (result.success) {
        antMessage.success(`Reconnected to ${server.name}`);
        loadInitialData();
      } else {
        antMessage.error(result.error || 'Failed to reconnect');
      }
    } catch (error) {
      console.error('Failed to reconnect MCP server:', error);
      antMessage.error('Failed to reconnect MCP server');
    } finally {
      setConnectingServers(prev => {
        const newSet = new Set(prev);
        newSet.delete(server.id);
        return newSet;
      });
    }
  };

  const openEditServerModal = (server: MCPServerInfo) => {
    setEditingServer(server);
    editServerForm.setFieldsValue({
      name: server.name,
      command: server.command,
      args: server.args ? server.args.join(' ') : '',
    });
    setEditServerModalVisible(true);
  };

  const editMCPServer = async (values: any) => {
    if (!editingServer) return;

    // 防止重复编辑
    if (isEditingServer) {
      return;
    }

    setIsEditingServer(true);

    try {
      // First disconnect the existing server
      await asyncBridge.disconnectMCPServer(editingServer.id);
      
      // Then reconnect with new configuration
      const result = await asyncBridge.connectMCPServer({
        name: values.name,
        command: values.command,
        args: values.args ? values.args.split(' ') : undefined
      });

      if (result.success) {
        antMessage.success(`Updated and reconnected ${values.name}`);
        loadInitialData();
        setEditServerModalVisible(false);
        setEditingServer(null);
        editServerForm.resetFields();
      } else {
        antMessage.error(result.error || 'Failed to update server');
      }
    } catch (error) {
      console.error('Failed to edit MCP server:', error);
      antMessage.error('Failed to edit MCP server');
    } finally {
      setIsEditingServer(false);
    }
  };

  const saveAIConfig = async (values: any) => {
    try {
      const patch: any = {};
      const normalizedProvider = normalizeAIProvider(values.provider);
      if (typeof values.provider === 'string' && values.provider.trim()) {
        patch.provider = values.provider.trim();
      }
      if (!isCodexProvider(normalizedProvider)) {
        if (typeof values.apiKey === 'string' && values.apiKey.trim()) {
          patch.apiKey = values.apiKey.trim();
        }
        if (typeof values.model === 'string' && values.model.trim()) {
          patch.model = values.model.trim();
        }
        if (typeof values.baseURL === 'string' && values.baseURL.trim()) {
          patch.baseURL = values.baseURL.trim();
        }
      }
      if (typeof values.codexCommand === 'string' && values.codexCommand.trim()) {
        patch.codexCommand = values.codexCommand.trim();
      }
      if (typeof values.codexModel === 'string' && values.codexModel.trim()) {
        patch.codexModel = values.codexModel.trim();
      }
      if (typeof values.codexProfile === 'string' && values.codexProfile.trim()) {
        patch.codexProfile = values.codexProfile.trim();
      }
      if (typeof values.codexSandbox === 'string' && values.codexSandbox.trim()) {
        patch.codexSandbox = values.codexSandbox.trim();
      }

      await asyncBridge.updateAIConfig(patch);
      
      antMessage.success('AI configuration saved successfully');
      setConfigModalVisible(false);
      const nextConfig = await asyncBridge.getAIConfig();
      syncAIConfigState(nextConfig);
    } catch (error) {
      console.error('Failed to save AI config:', error);
      antMessage.error('Failed to save AI configuration');
    }
  };

  // Load AI config when opening settings modal
  const openSettingsModal = async () => {
    try {
      const config = await asyncBridge.getAIConfig();
      form.setFieldsValue({
        provider: normalizeAIProvider(config.provider),
        apiKey: '', // Don't pre-fill API key for security
        model: config.model,
        baseURL: config.baseURL,
        codexCommand: config.codexCommand,
        codexModel: config.codexModel,
        codexProfile: config.codexProfile,
        codexSandbox: config.codexSandbox || 'read-only'
      });
      setConfigModalVisible(true);
    } catch (error) {
      console.error('Failed to load AI config:', error);
      setConfigModalVisible(true);
    }
  };

  const deleteMCPServer = async (serverId: string) => {
    // 防止重复删除
    if (disconnectingServers.has(serverId)) {
      return;
    }

    setDisconnectingServers(prev => new Set(prev).add(serverId));

    try {
      // First disconnect if connected
      await asyncBridge.disconnectMCPServer(serverId);
      antMessage.success('MCP server removed successfully');
      loadInitialData();
    } catch (error) {
      console.error('Failed to delete MCP server:', error);
      antMessage.error('Failed to remove MCP server');
    } finally {
      setDisconnectingServers(prev => {
        const newSet = new Set(prev);
        newSet.delete(serverId);
        return newSet;
      });
    }
  };

  const updateContextSource = async (sourceId: string, enabled: boolean) => {
    try {
      await asyncBridge.setContextSourceEnabled(sourceId, enabled);
      setContextSources(prev => 
        prev.map(source => 
          source.id === sourceId ? { ...source, enabled } : source
        )
      );
    } catch (error) {
      console.error('Failed to update context source:', error);
      antMessage.error('Failed to update context source');
    }
  };

  const hasStreamingAssistant = messages.some(message => message.role === 'assistant' && message.streaming);

  const renderChatTab = () => (
    <div className="ai-chat-container">
      <div className="chat-messages" ref={chatMessagesRef} onScroll={handleChatMessagesScroll}>
        {!isAIConfigured && (
          <div style={{ 
            padding: '16px', 
            background: '#fff7e6', 
            border: '1px solid #ffd591', 
            borderRadius: '6px', 
            marginBottom: '16px',
            textAlign: 'center'
          }}>
            <Text>
              AI Assistant is not configured yet. Please open{' '}
              <Button 
                type="link" 
                size="small" 
                onClick={openSettingsModal}
                style={{ padding: 0 }}
              >
                Settings
              </Button>
              {' '}and choose an available provider to start chatting.
            </Text>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <Avatar 
              icon={msg.role === 'user' ? <UserOutlined /> : <RobotOutlined />}
              className="message-avatar"
            />
            <div className="message-content">
              <div className="message-header">
                <Text strong>{msg.role === 'user' ? 'You' : 'AI Assistant'}</Text>
                <Text type="secondary" className="message-time">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </Text>
              </div>
              <div className="message-text">
                {msg.content}
              </div>
              {msg.role === 'assistant' && msg.statusText && (
                <div className="message-status">
                  {msg.statusText}
                  {msg.streaming && !msg.content && <Spin size="small" style={{ marginLeft: 8 }} />}
                </div>
              )}
              {msg.metadata?.mcpToolsUsed && msg.metadata.mcpToolsUsed.length > 0 && (
                <div className="message-tools">
                  <Text type="secondary">Tools used: </Text>
                  {msg.metadata.mcpToolsUsed.map(tool => (
                    <Tag key={tool} icon={<ToolOutlined />}>{tool}</Tag>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {isLoading && !hasStreamingAssistant && (
          <div className="message assistant">
            <Avatar icon={<RobotOutlined />} className="message-avatar" />
            <div className="message-content">
              <Spin size="small" /> AI is thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      
      <div className="chat-input-area">
        <div className="chat-options">
          <Space>
            <Switch
              checked={includeDebugContext}
              onChange={setIncludeDebugContext}
              size="small"
            />
            <Text>Include debug context</Text>
            
            <Select
              mode="multiple"
              placeholder="Select MCP tools"
              style={{ minWidth: 200 }}
              value={selectedMCPTools}
              onChange={setSelectedMCPTools}
              size="small"
            >
              {mcpTools.map(tool => (
                <Select.Option key={`${tool.serverId}-${tool.name}`} value={tool.name}>
                  {tool.name} ({tool.serverId})
                </Select.Option>
              ))}
            </Select>
            
            <Button
              icon={<ClearOutlined />}
              onClick={clearConversation}
              size="small"
              type="text"
            >
              Clear
            </Button>
          </Space>
        </div>
        
        <div className="chat-input">
          <TextArea
            className="chat-compose-input"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            placeholder={getChatPlaceholder()}
            autoSize={{ minRows: 2, maxRows: 8 }}
            disabled={!isAIConfigured}
            onPressEnter={(e) => {
              if (!e.shiftKey && isAIConfigured) {
                e.preventDefault();
                sendMessage();
              }
            }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={sendMessage}
            loading={isLoading}
            disabled={!inputMessage.trim() || !isAIConfigured}
            title={!isAIConfigured ? 'Please configure an AI provider first' : undefined}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );

  const renderMCPTab = () => (
    <div className="mcp-container">
      <div className="mcp-header">
        <Title level={4}>MCP Servers</Title>
        <Button
          type="primary"
          onClick={() => setAddServerModalVisible(true)}
        >
          Add Server
        </Button>
      </div>
      
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <List
          style={{ flex: '0 0 auto', marginBottom: 16 }}
          dataSource={mcpServers}
          renderItem={(server) => (
            <List.Item
              actions={[
                <Badge
                  key="status"
                  status={
                    server.status === 'connected' ? 'success' :
                    server.status === 'connecting' ? 'processing' :
                    server.status === 'error' ? 'error' : 'default'
                  }
                  text={server.status}
                />,
                <Space key="actions" size="small">
                  <Button
                    size="small"
                    onClick={() => openEditServerModal(server)}
                    disabled={
                      connectingServers.has(server.id) || 
                      disconnectingServers.has(server.id) ||
                      server.status === 'connecting'
                    }
                  >
                    Edit
                  </Button>
                  {server.status === 'connected' ? (
                    <Button
                      size="small"
                      danger
                      loading={disconnectingServers.has(server.id)}
                      disabled={disconnectingServers.has(server.id)}
                      onClick={() => disconnectMCPServer(server.id)}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      loading={server.status === 'connecting' || connectingServers.has(server.id)}
                      disabled={server.status === 'connecting' || connectingServers.has(server.id)}
                      onClick={() => reconnectMCPServer(server)}
                    >
                      Connect
                    </Button>
                  )}
                  <Popconfirm
                    title="Delete MCP Server"
                    description="Are you sure you want to delete this MCP server?"
                    onConfirm={() => deleteMCPServer(server.id)}
                    okText="Yes"
                    cancelText="No"
                  >
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={
                        connectingServers.has(server.id) || 
                        disconnectingServers.has(server.id) ||
                        server.status === 'connecting'
                      }
                    />
                  </Popconfirm>
                </Space>
              ]}
            >
              <List.Item.Meta
                title={server.name}
                description={
                  <div>
                    <div>{server.error || `Server ID: ${server.id}`}</div>
                    <div style={{ fontSize: '12px', color: '#999', marginTop: '4px' }}>
                      Command: {server.command} {server.args?.join(' ')}
                    </div>
                  </div>
                }
              />
            </List.Item>
          )}
        />
        
        <Title level={4} style={{ marginBottom: 16, flexShrink: 0 }}>Available Tools</Title>
        <List
          style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
          dataSource={mcpTools}
          renderItem={(tool) => (
            <List.Item>
              <List.Item.Meta
                title={tool.name}
                description={tool.description || 'No description available'}
              />
              <Tag>{tool.serverId}</Tag>
            </List.Item>
          )}
        />
      </div>
    </div>
  );

  const renderContextTab = () => (
    <div className="context-container">
      <Title level={4}>Debug Context Sources</Title>
      <List
        style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
        dataSource={contextSources}
        renderItem={(source) => (
          <List.Item
            actions={[
              <Switch
                key="toggle"
                checked={source.enabled}
                onChange={(enabled) => updateContextSource(source.id, enabled)}
              />
            ]}
          >
            <List.Item.Meta
              title={source.name}
              description={source.description}
            />
            <Tag color={source.enabled ? 'green' : 'default'}>
              {source.category}
            </Tag>
          </List.Item>
        )}
      />
      
      <Button
        icon={<BugOutlined />}
        onClick={async () => {
          try {
            const context = await asyncBridge.collectDebugContext();
            console.log('Current debug context:', context);
            antMessage.success('Debug context collected (check console)');
          } catch (error) {
            antMessage.error('Failed to collect debug context');
          }
        }}
        style={{ marginTop: 16, flexShrink: 0 }}
      >
        Collect Debug Context
      </Button>
    </div>
  );

  return (
    <div className="ai-assistant-view">
      <div className="ai-assistant-header">
        <Title level={3}>
          <RobotOutlined /> AI Assistant
        </Title>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={loadInitialData}
            size="small"
          >
            Refresh
          </Button>
          <Button
            icon={<SettingOutlined />}
            onClick={openSettingsModal}
            size="small"
          >
            Settings
          </Button>
        </Space>
      </div>

      <Tabs 
        activeKey={activeTab} 
        onChange={setActiveTab}
        className="ai-assistant-tabs"
        items={[
          {
            key: 'chat',
            label: 'Chat',
            children: renderChatTab()
          },
          {
            key: 'mcp',
            label: 'MCP Servers',
            children: renderMCPTab()
          },
          {
            key: 'context',
            label: 'Context',
            children: renderContextTab()
          }
        ]}
      />

      {/* Add Server Modal */}
      <Modal
        title="Add MCP Server"
        open={addServerModalVisible}
        onCancel={() => {
          setAddServerModalVisible(false);
          serverForm.resetFields();
          setIsAddingServer(false);
        }}
        footer={null}
        width={600}
      >
        <div style={{ marginBottom: 16 }}>
          <Text strong>Quick Templates:</Text>
          <div style={{ marginTop: 8 }}>
            <Space wrap>
              {mcpServerTemplates.map((template, index) => (
                <Button
                  key={index}
                  size="small"
                  onClick={() => applyServerTemplate(template)}
                >
                  {template.name}
                </Button>
              ))}
            </Space>
          </div>
        </div>
        
        <Form form={serverForm} onFinish={connectMCPServer} layout="vertical">
          <Form.Item
            name="name"
            label="Server Name"
            rules={[{ required: true, message: 'Please enter server name' }]}
          >
            <Input placeholder="e.g., Filesystem MCP" />
          </Form.Item>
          <Form.Item
            name="command"
            label="Command"
            rules={[{ required: true, message: 'Please enter command' }]}
          >
            <Input placeholder="e.g., npx" />
          </Form.Item>
          <Form.Item
            name="args"
            label="Arguments"
          >
            <Input placeholder="e.g., -y @modelcontextprotocol/server-filesystem /tmp" />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button 
                type="primary" 
                htmlType="submit"
                loading={isAddingServer}
                disabled={isAddingServer}
              >
                Connect
              </Button>
              <Button 
                onClick={() => {
                  setAddServerModalVisible(false);
                  serverForm.resetFields();
                }}
                disabled={isAddingServer}
              >
                Cancel
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit Server Modal */}
      <Modal
        title="Edit MCP Server"
        open={editServerModalVisible}
        onCancel={() => {
          setEditServerModalVisible(false);
          setEditingServer(null);
          editServerForm.resetFields();
          setIsEditingServer(false);
        }}
        footer={null}
      >
        <Form form={editServerForm} onFinish={editMCPServer} layout="vertical">
          <Form.Item
            name="name"
            label="Server Name"
            rules={[{ required: true, message: 'Please enter server name' }]}
          >
            <Input placeholder="e.g., Filesystem MCP" />
          </Form.Item>
          <Form.Item
            name="command"
            label="Command"
            rules={[{ required: true, message: 'Please enter command' }]}
          >
            <Input placeholder="e.g., npx" />
          </Form.Item>
          <Form.Item
            name="args"
            label="Arguments"
          >
            <Input placeholder="e.g., -y @modelcontextprotocol/server-filesystem /tmp" />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button 
                type="primary" 
                htmlType="submit"
                loading={isEditingServer}
                disabled={isEditingServer}
              >
                Update & Reconnect
              </Button>
              <Button 
                onClick={() => {
                  setEditServerModalVisible(false);
                  setEditingServer(null);
                  editServerForm.resetFields();
                }}
                disabled={isEditingServer}
              >
                Cancel
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* Settings Modal */}
      <Modal
        title="AI Assistant Settings"
        open={configModalVisible}
        onCancel={() => setConfigModalVisible(false)}
        footer={null}
      >
        <Form form={form} onFinish={saveAIConfig} layout="vertical">
          <Form.Item name="provider" label="Provider" initialValue="codex-sdk">
            <Select
              options={[
                { value: 'codex-sdk', label: 'Codex SDK' },
                { value: 'ark', label: 'Ark' },
                { value: 'anthropic', label: 'Anthropic' }
              ]}
            />
          </Form.Item>

          {selectedProvider === 'codex-sdk' ? (
            <>
              <Form.Item name="codexCommand" label="Codex Binary Override (optional)">
                <Input placeholder="Leave blank to use the SDK bundled Codex binary" />
              </Form.Item>
              <Form.Item name="codexModel" label="Codex Model (optional)">
                <Input placeholder="Leave blank to use the Codex SDK default model" />
              </Form.Item>
              <Form.Item name="codexSandbox" label="Codex Sandbox">
                <Select
                  options={[
                    { value: 'read-only', label: 'Read Only' },
                    { value: 'workspace-write', label: 'Workspace Write' },
                    { value: 'danger-full-access', label: 'Danger Full Access' }
                  ]}
                />
              </Form.Item>
              <Form.Item>
                <Text type="secondary">
                  Codex SDK mode reuses the current Elements and Console context, then runs a one-shot
                  Codex thread for reasoning. It uses your local Codex authentication by default and
                  does not reuse the Ark API key or base URL fields. The official SDK still recommends
                  Node 18+.
                </Text>
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="apiKey" label="API Key">
                <Input.Password placeholder="Enter your AI provider API key" />
              </Form.Item>
              <Form.Item name="model" label="Model">
                <Input placeholder="e.g., claude-3-5-sonnet-20241022" />
              </Form.Item>
              <Form.Item name="baseURL" label="Base URL (optional)">
                <Input placeholder="Custom API endpoint" />
              </Form.Item>
            </>
          )}
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">
                Save
              </Button>
              <Button onClick={() => setConfigModalVisible(false)}>
                Cancel
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}; 
