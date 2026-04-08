// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ChildProcess } from 'child_process';

export interface MCPServerConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPServerInfo extends MCPServerConfig {
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  client?: Client;
  process?: ChildProcess;
  error?: string;
  connectedAt?: Date;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: any;
  serverId: string;
}

export class MCPClientManager {
  private servers = new Map<string, MCPServerInfo>();
  private defaultServers: MCPServerConfig[] = [
    {
      id: 'filesystem',
      name: 'Filesystem MCP',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
    },
    {
      id: 'brave-search',
      name: 'Brave Search MCP',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search']
    },
    {
      id: 'lynxbase-mcp',
      name: 'Lynx Base MCP',
      command: 'npx',
      args: ['-y', '--registry', 'https://bnpm.byted.org', '@byted-lynx/lynx-base-mcp-server@latest']
    },
    {
      id: 'lynx-devtool',
      name: 'Lynx Devtool MCP',
      command: 'npx',
      args: ['-y', '--registry', 'https://bnpm.byted.org', '@byted-lynx/devtool-mcp-server@latest']
    }
  ];

  constructor() {
    // Initialize with default servers
    this.defaultServers.forEach(config => {
      this.servers.set(config.id, {
        ...config,
        status: 'disconnected'
      });
    });
  }

  async listServers(): Promise<MCPServerInfo[]> {
    return Array.from(this.servers.values()).map(server => ({
      ...server,
      // Don't expose sensitive objects in the response
      client: undefined,
      process: undefined
    }));
  }

  async connectServer(config: { name: string; command: string; args?: string[]; env?: Record<string, string> }): Promise<{ success: boolean; error?: string }> {
    // Check if there's an existing server with the same name and config
    let existingServer: MCPServerInfo | undefined;
    let id: string = this.generateServerId(config.name); // Default ID
    
    for (const [serverId, server] of this.servers.entries()) {
      if (server.name === config.name && 
          server.command === config.command && 
          JSON.stringify(server.args) === JSON.stringify(config.args)) {
        existingServer = server;
        id = serverId; // Reuse existing ID
        break;
      }
    }

    if (existingServer?.status === 'connected') {
      return { success: true };
    }
    
    try {
      const serverInfo: MCPServerInfo = {
        id,
        ...config,
        status: 'connecting'
      };

      this.servers.set(id, serverInfo);

      // Create transport and client
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: config.env ? { ...process.env, ...config.env } : undefined
      });

      const client = new Client({
        name: 'lynx-devtool-ai-assistant',
        version: '1.0.0'
      }, {
        capabilities: {
          tools: {}
        }
      });

      transport.onerror = (error) => {
        console.error(`MCP server ${id} transport error:`, error);
        serverInfo.status = 'error';
        serverInfo.error = error.message;
      };

      transport.onclose = () => {
        console.log(`MCP server ${id} transport closed`);
        serverInfo.status = 'disconnected';
      };

      // Connect the client
      await client.connect(transport);
      
      // Update server info
      serverInfo.client = client;
      serverInfo.process = undefined;
      serverInfo.status = 'connected';
      serverInfo.connectedAt = new Date();

      console.log(`Successfully connected to MCP server: ${config.name}`);
      return { success: true };

    } catch (error) {
      console.error(`Failed to connect to MCP server ${config.name}:`, error);
      
      const serverInfo = this.servers.get(id);
      if (serverInfo) {
        serverInfo.status = 'error';
        serverInfo.error = error instanceof Error ? error.message : 'Unknown error';
      }

      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  async disconnectServer(serverId: string): Promise<{ success: boolean; error?: string }> {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo) {
      return { success: false, error: 'Server not found' };
    }

    try {
      // Close client connection
      if (serverInfo.client) {
        await serverInfo.client.close();
      }

      // Kill process
      if (serverInfo.process && !serverInfo.process.killed) {
        serverInfo.process.kill();
      }

      // Update status
      serverInfo.status = 'disconnected';
      serverInfo.client = undefined;
      serverInfo.process = undefined;
      serverInfo.error = undefined;

      console.log(`Disconnected from MCP server: ${serverInfo.name}`);
      return { success: true };

    } catch (error) {
      console.error(`Failed to disconnect from MCP server ${serverInfo.name}:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  async listTools(serverId?: string): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];

    const serversToCheck = serverId 
      ? [this.servers.get(serverId)].filter(Boolean)
      : Array.from(this.servers.values()).filter(server => server.status === 'connected');

    for (const server of serversToCheck) {
      if (server && server.client && server.status === 'connected') {
        try {
          const result = await server.client.listTools();
          if (result.tools) {
            tools.push(...result.tools.map((tool: any) => ({
              ...tool,
              serverId: server.id
            })));
          }
        } catch (error) {
          console.error(`Failed to list tools from server ${server.name}:`, error);
        }
      }
    }

    return tools;
  }

  async callTool(serverId: string, toolName: string, arguments_: any): Promise<any> {
    const serverInfo = this.servers.get(serverId);
    
    if (!serverInfo || !serverInfo.client || serverInfo.status !== 'connected') {
      throw new Error(`Server ${serverId} is not connected`);
    }

    try {
      let normalizedArgs: any = arguments_;
      if (normalizedArgs === undefined || normalizedArgs === null) {
        normalizedArgs = {};
      } else if (typeof normalizedArgs === 'string') {
        const trimmed = normalizedArgs.trim();
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            normalizedArgs = parsed;
          } else if (Array.isArray(parsed)) {
            normalizedArgs = { items: parsed };
          } else {
            normalizedArgs = { value: parsed };
          }
        } catch {
          normalizedArgs = { query: trimmed };
        }
      } else if (Array.isArray(normalizedArgs)) {
        normalizedArgs = { items: normalizedArgs };
      } else if (typeof normalizedArgs !== 'object') {
        normalizedArgs = { value: normalizedArgs };
      } else {
        const keys = Object.keys(normalizedArgs);
        if (
          keys.length === 1 &&
          keys[0] === 'arguments' &&
          typeof (normalizedArgs as any).arguments === 'string'
        ) {
          const inner = String((normalizedArgs as any).arguments).trim();
          try {
            const parsed = JSON.parse(inner);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              normalizedArgs = parsed;
            } else if (Array.isArray(parsed)) {
              normalizedArgs = { items: parsed };
            } else {
              normalizedArgs = { value: parsed };
            }
          } catch {
            normalizedArgs = { query: inner };
          }
        }
      }

      const result = await serverInfo.client.callTool({
        name: toolName,
        arguments: normalizedArgs
      });

      return result;
    } catch (error) {
      console.error(`Failed to call tool ${toolName} on server ${serverId}:`, error);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    const disconnectPromises = Array.from(this.servers.keys()).map(serverId => 
      this.disconnectServer(serverId)
    );

    await Promise.allSettled(disconnectPromises);
    this.servers.clear();
  }

  private generateServerId(name: string): string {
    const baseId = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    let id = baseId;
    let counter = 1;
    
    while (this.servers.has(id)) {
      id = `${baseId}-${counter}`;
      counter++;
    }
    
    return id;
  }

  getConnectedClients(): Map<string, Client> {
    const clients = new Map<string, Client>();
    
    for (const [id, server] of this.servers.entries()) {
      if (server.status === 'connected' && server.client) {
        clients.set(id, server.client);
      }
    }
    
    return clients;
  }
} 
