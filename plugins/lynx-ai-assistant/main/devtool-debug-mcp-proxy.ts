// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { app } from 'electron';
import { MainContext } from '@lynx-js/devtool-plugin-core/main';
import { MCPClientManager } from './mcp-client-manager';
import {
  DEVTOOL_DEBUG_MCP_ENTRY_NAME,
  DEVTOOL_DEBUG_MCP_PROXY_PATH,
  DEVTOOL_DEBUG_MCP_PROXY_TOKEN_ENV,
  DEVTOOL_DEBUG_MCP_PROXY_URL_ENV,
  DEVTOOL_DEBUG_MCP_SERVER_NAME,
  DevtoolDebugProxyRequest,
  DevtoolDebugProxyResponse
} from '../shared/devtool-debug-mcp';

type DebugLogger = (payload: Record<string, any>) => void;

interface ProxyState {
  server: http.Server;
  url: string;
  token: string;
}

const isLoopbackAddress = (value?: string | null) => {
  if (!value) {
    return false;
  }
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
};

const collectRequestBody = async (request: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const previewValue = (value: unknown, maxLength = 800) => {
  if (value === undefined) {
    return '';
  }
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
  } catch {
    const text = String(value);
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
  }
};

export class DevtoolDebugMCPProxy {
  private context: MainContext;
  private proxyState: ProxyState | null = null;

  constructor(
    context: MainContext,
    private readonly mcpClientManager: MCPClientManager,
    private readonly reportDbg: DebugLogger
  ) {
    this.context = context;
  }

  setContext(context: MainContext) {
    this.context = context;
  }

  async ensureConnected(): Promise<void> {
    const proxyState = await this.ensureProxyServer();
    const scriptPath = this.resolveRuntimeScriptPath();

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Debug MCP runtime entry not found: ${scriptPath}`);
    }

    const result = await this.mcpClientManager.connectServer({
      name: DEVTOOL_DEBUG_MCP_SERVER_NAME,
      command: process.execPath,
      args: [scriptPath],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        [DEVTOOL_DEBUG_MCP_PROXY_URL_ENV]: proxyState.url,
        [DEVTOOL_DEBUG_MCP_PROXY_TOKEN_ENV]: proxyState.token
      }
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to connect local debug MCP server');
    }
  }

  async dispose(): Promise<void> {
    if (!this.proxyState) {
      return;
    }
    const { server } = this.proxyState;
    this.proxyState = null;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  }

  private resolveRuntimeScriptPath() {
    const appPath = app.getAppPath();
    return path.join(appPath, 'dist', `${DEVTOOL_DEBUG_MCP_ENTRY_NAME}.js`);
  }

  private async ensureProxyServer(): Promise<ProxyState> {
    if (this.proxyState) {
      return this.proxyState;
    }

    const token = randomBytes(24).toString('hex');
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response, token);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Failed to determine local MCP proxy address');
    }

    this.proxyState = {
      server,
      url: `http://127.0.0.1:${address.port}${DEVTOOL_DEBUG_MCP_PROXY_PATH}`,
      token
    };

    return this.proxyState;
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    token: string
  ) {
    if (request.method !== 'POST' || request.url !== DEVTOOL_DEBUG_MCP_PROXY_PATH) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'Not found' } satisfies DevtoolDebugProxyResponse));
      return;
    }

    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'Loopback access only' } satisfies DevtoolDebugProxyResponse));
      return;
    }

    if (request.headers['x-lynx-devtool-token'] !== token) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'Unauthorized' } satisfies DevtoolDebugProxyResponse));
      return;
    }

    try {
      const body = await collectRequestBody(request);
      const payload = (body ? JSON.parse(body) : {}) as DevtoolDebugProxyRequest;
      this.reportDbg({
        hypothesisId: 'DMCP',
        msg: '[DEBUG] local debug MCP proxy request received',
        location: 'main/devtool-debug-mcp-proxy.ts',
        data: {
          type: payload.type || 'CDP',
          method: payload.method,
          paramsKeys: payload.params ? Object.keys(payload.params) : [],
          paramsPreview: previewValue(payload.params)
        }
      });
      const result = await this.context.invokePluginEvent({
        eventName: 'EXECUTE_CDP_COMMAND',
        params: {
          type: payload.type || 'CDP',
          method: payload.method,
          params: payload.params || {}
        }
      });

      this.reportDbg({
        hypothesisId: 'DMCP',
        msg: '[DEBUG] local debug MCP proxy request succeeded',
        location: 'main/devtool-debug-mcp-proxy.ts',
        data: {
          type: payload.type || 'CDP',
          method: payload.method,
          resultPreview: previewValue(result)
        }
      });

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result } satisfies DevtoolDebugProxyResponse));
    } catch (error) {
      this.reportDbg({
        hypothesisId: 'DMCP',
        msg: '[DEBUG] local debug MCP proxy request failed',
        location: 'main/devtool-debug-mcp-proxy.ts',
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies DevtoolDebugProxyResponse)
      );
    }
  }
}
