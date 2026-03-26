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

interface AIAssistantViewProps {
  context: RendererContext<AIAssistantBridgeType>;
}

export const AIAssistantView: React.FC<AIAssistantViewProps> = ({ context }) => {
  const { asyncBridge } = context;
  
  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [includeDebugContext, setIncludeDebugContext] = useState(true);
  const [selectedMCPTools, setSelectedMCPTools] = useState<string[]>([]);
  const [hasApiKey, setHasApiKey] = useState(false);
  
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
  const [form] = Form.useForm();
  const [serverForm] = Form.useForm();
  const [editServerForm] = Form.useForm();

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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const stateRef = useRef({ includeDebugContext, selectedMCPTools, isLoading });
  useEffect(() => {
      stateRef.current = { includeDebugContext, selectedMCPTools, isLoading };
  }, [includeDebugContext, selectedMCPTools, isLoading]);

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

      // Handle Console Insight requests (inline analysis, separate from chat)
      if (event.data?.type === 'lynx-console-insight-request') {
        const { requestId, errorMessage, stackTrace, sourceDirectory } = event.data.content;
        const source = event.source as Window;

        try {
          const result = await asyncBridge.analyzeConsoleError({
            requestId,
            errorMessage,
            stackTrace,
            sourceDirectory
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
        setIsLoading(true);
        
        try {
            if (event.data.type === 'lynx-ai-elements-request') {
              const r = await asyncBridge.connectMCPServer({
                name: 'Lynx Base MCP',
                command: 'npx',
                args: ['-y', '--registry', 'https://bnpm.byted.org', '@byted-lynx/lynx-base-mcp-server@latest']
              });
              if (r && r.success === false && r.error) {
                antMessage.warning(`Failed to connect Lynx Base MCP: ${r.error}`);
              }
            }
            const newMessage: ChatMessage = {
                id: Date.now().toString(),
                role: 'user',
                content: prompt,
                timestamp: new Date()
            };
            setMessages(prev => [...prev, newMessage]);

            await asyncBridge.sendMessage(prompt, {
                includeDebugContext,
                mcpTools: selectedMCPTools,
                target: {
                  clientId: clientId !== undefined ? String(clientId) : undefined,
                  sessionId: typeof sessionId === 'number' ? sessionId : undefined
                }
            });
            const history = await asyncBridge.getConversationHistory();
            setMessages(history);
        } catch (error) {
             console.error('Failed to analyze error:', error);
             antMessage.error('Failed to analyze error');
        } finally {
             setIsLoading(false);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [asyncBridge]);

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
      setHasApiKey(!!aiConfig.apiKey);
    } catch (error) {
      console.error('Failed to load initial data:', error);
      antMessage.error('Failed to initialize AI Assistant');
    }
  };

  const sendMessage = async () => {
    if (!inputMessage.trim() || isLoading) return;

    const userMessage = inputMessage.trim();
    setInputMessage('');
    setIsLoading(true);

    try {
      const response = await asyncBridge.sendMessage(userMessage, {
        includeDebugContext,
        mcpTools: selectedMCPTools
      });

      // Refresh conversation history
      const history = await asyncBridge.getConversationHistory();
      setMessages(history);
    } catch (error) {
      console.error('Failed to send message:', error);
      antMessage.error('Failed to send message');
    } finally {
      setIsLoading(false);
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
      if (typeof values.apiKey === 'string' && values.apiKey.trim()) {
        patch.apiKey = values.apiKey.trim();
      }
      if (typeof values.model === 'string' && values.model.trim()) {
        patch.model = values.model.trim();
      }
      if (typeof values.baseURL === 'string' && values.baseURL.trim()) {
        patch.baseURL = values.baseURL.trim();
      }

      await asyncBridge.updateAIConfig(patch);
      
      antMessage.success('AI configuration saved successfully');
      setConfigModalVisible(false);
      const nextConfig = await asyncBridge.getAIConfig();
      setHasApiKey(!!nextConfig.apiKey);
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
        apiKey: '', // Don't pre-fill API key for security
        model: config.model,
        baseURL: config.baseURL
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

  const renderChatTab = () => (
    <div className="ai-chat-container">
      <div className="chat-messages">
        {!hasApiKey && (
          <div style={{ 
            padding: '16px', 
            background: '#fff7e6', 
            border: '1px solid #ffd591', 
            borderRadius: '6px', 
            marginBottom: '16px',
            textAlign: 'center'
          }}>
            <Text>
              🤖 Welcome to AI Assistant! Please configure your API key in{' '}
              <Button 
                type="link" 
                size="small" 
                onClick={openSettingsModal}
                style={{ padding: 0 }}
              >
                Settings
              </Button>{' '}
              to start chatting with AI.
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
        {isLoading && (
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
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            placeholder={hasApiKey ? "Ask about debugging issues, errors, or anything related to your app..." : "Please configure API key in Settings first"}
            autoSize={{ minRows: 2, maxRows: 6 }}
            disabled={!hasApiKey}
            onPressEnter={(e) => {
              if (!e.shiftKey && hasApiKey) {
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
            disabled={!inputMessage.trim() || !hasApiKey}
            title={!hasApiKey ? 'Please configure API key first' : undefined}
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
          <Form.Item name="apiKey" label="API Key">
            <Input.Password placeholder="Enter your AI provider API key" />
          </Form.Item>
          <Form.Item name="model" label="Model">
            <Input placeholder="e.g., claude-3-5-sonnet-20241022" />
          </Form.Item>
          <Form.Item name="baseURL" label="Base URL (optional)">
            <Input placeholder="Custom API endpoint" />
          </Form.Item>
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
