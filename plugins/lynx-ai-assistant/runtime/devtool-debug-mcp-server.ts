// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  DEVTOOL_DEBUG_MCP_BOUND_CLIENT_ID_ENV,
  DEVTOOL_DEBUG_MCP_BOUND_SESSION_ID_ENV,
  DEVTOOL_DEBUG_MCP_PROXY_TOKEN_ENV,
  DEVTOOL_DEBUG_MCP_PROXY_URL_ENV,
  DEVTOOL_DEBUG_MCP_SERVER_NAME,
  DEVTOOL_DEBUG_MCP_TOOLS,
  DevtoolDebugProxyRequest,
  DevtoolDebugProxyResponse
} from '../shared/devtool-debug-mcp';

const proxyUrl = process.env[DEVTOOL_DEBUG_MCP_PROXY_URL_ENV];
const proxyToken = process.env[DEVTOOL_DEBUG_MCP_PROXY_TOKEN_ENV];

if (!proxyUrl || !proxyToken) {
  const missing = [
    !proxyUrl ? DEVTOOL_DEBUG_MCP_PROXY_URL_ENV : null,
    !proxyToken ? DEVTOOL_DEBUG_MCP_PROXY_TOKEN_ENV : null
  ]
    .filter(Boolean)
    .join(', ');
  process.stderr.write(`[${DEVTOOL_DEBUG_MCP_SERVER_NAME}] Missing required environment: ${missing}\n`);
  process.exit(1);
}

const server = new Server(
  {
    name: DEVTOOL_DEBUG_MCP_SERVER_NAME,
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

const normalizeInteger = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
};

const boundClientId = normalizeInteger(process.env[DEVTOOL_DEBUG_MCP_BOUND_CLIENT_ID_ENV]);
const boundSessionId = normalizeInteger(process.env[DEVTOOL_DEBUG_MCP_BOUND_SESSION_ID_ENV]);

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

const logDebug = (stage: string, data?: Record<string, any>) => {
  process.stderr.write(
    `[${DEVTOOL_DEBUG_MCP_SERVER_NAME}] ${previewValue({
      stage,
      data
    })}\n`
  );
};

const applyBoundTarget = (params: Record<string, any>) => {
  if (boundClientId !== undefined) {
    params.clientId = boundClientId;
  }
  if (boundSessionId !== undefined) {
    params.sessionId = boundSessionId;
  }
  return params;
};

const normalizeTargetParams = (args: Record<string, any>, extras?: Record<string, any>) => {
  const params: Record<string, any> = {
    ...(extras || {})
  };
  const clientId = normalizeInteger(args.clientId);
  const sessionId = normalizeInteger(args.sessionId);
  if (clientId !== undefined) {
    params.clientId = clientId;
  }
  if (sessionId !== undefined) {
    params.sessionId = sessionId;
  }
  return applyBoundTarget(params);
};

const resolveTargetParams = async (args: Record<string, any>, extras?: Record<string, any>) => {
  const params = normalizeTargetParams(args, extras);
  if (params.clientId !== undefined && params.sessionId !== undefined) {
    logDebug('resolve-target.bound', {
      args: previewValue(args),
      extras: previewValue(extras),
      resolvedTarget: params
    });
    return params;
  }

  try {
    const activeTarget = await invokeCommand('Device', 'Device.getActiveTarget', normalizeTargetParams(args));
    const activeClientId = normalizeInteger(activeTarget?.clientId);
    const activeSessionId = normalizeInteger(activeTarget?.sessionId);
    if (params.clientId === undefined && activeClientId !== undefined) {
      params.clientId = activeClientId;
    }
    if (params.sessionId === undefined && activeSessionId !== undefined) {
      params.sessionId = activeSessionId;
    }
  } catch (error) {
    process.stderr.write(
      `[${DEVTOOL_DEBUG_MCP_SERVER_NAME}] Failed to resolve active target: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
  }

  logDebug('resolve-target.active', {
    args: previewValue(args),
    extras: previewValue(extras),
    resolvedTarget: params
  });

  return params;
};

const proxyInvoke = async (request: DevtoolDebugProxyRequest): Promise<any> => {
  const url = new URL(String(proxyUrl));
  const body = JSON.stringify(request);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-lynx-devtool-token': String(proxyToken)
        }
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let payload: DevtoolDebugProxyResponse | undefined;
          try {
            payload = text ? JSON.parse(text) : undefined;
          } catch (error) {
            reject(new Error(`Failed to parse MCP proxy response: ${error instanceof Error ? error.message : String(error)}`));
            return;
          }

          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(payload?.error || `Proxy request failed with status ${res.statusCode}`));
            return;
          }
          if (!payload?.ok) {
            reject(new Error(payload?.error || 'Proxy request failed'));
            return;
          }
          resolve(payload.result);
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Proxy request timed out'));
    });
    req.write(body);
    req.end();
  });
};

const invokeCommand = async (
  type: 'CDP' | 'Device' | 'App',
  method: string,
  params?: Record<string, any>
) => {
  return proxyInvoke({
    type,
    method,
    params
  });
};

const compactStyleResult = (result: any) => {
  if (!result?.result?.computedStyle || !Array.isArray(result.result.computedStyle)) {
    return result;
  }
  const styleEntries = result.result.computedStyle.slice(0, 120);
  return {
    ...result,
    result: {
      ...result.result,
      computedStyle: styleEntries
    }
  };
};

const getNodeLayoutSnapshot = async (args: Record<string, any>) => {
  const nodeId = normalizeInteger(args.nodeId);
  if (nodeId === undefined) {
    throw new Error('nodeId is required');
  }

  const target = await resolveTargetParams(args);
  const depth = normalizeInteger(args.depth);
  const requestParams = { nodeId, ...(depth !== undefined ? { depth } : {}) };

  const [describeNode, boxModel, computedStyle, matchedStyles, innerText] = await Promise.allSettled([
    invokeCommand('CDP', 'DOM.describeNode', { ...target, ...requestParams }),
    invokeCommand('CDP', 'DOM.getBoxModel', { ...target, nodeId }),
    invokeCommand('CDP', 'CSS.getComputedStyleForNode', { ...target, nodeId }),
    invokeCommand('CDP', 'CSS.getMatchedStylesForNode', { ...target, nodeId }),
    invokeCommand('CDP', 'DOM.innerText', { ...target, nodeId })
  ]);

  const takeValue = (result: PromiseSettledResult<any>) =>
    result.status === 'fulfilled' ? result.value : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };

  return {
    nodeId,
    target,
    describeNode: takeValue(describeNode),
    boxModel: takeValue(boxModel),
    computedStyle: compactStyleResult(takeValue(computedStyle)),
    matchedStyles: takeValue(matchedStyles),
    innerText: takeValue(innerText)
  };
};

const toToolResult = (payload: any, isError = false) => {
  let text = '';
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  } catch {
    text = String(payload);
  }
  return {
    content: [
      {
        type: 'text' as const,
        text
      }
    ],
    ...(isError ? { isError: true } : {})
  };
};

const handleToolCall = async (name: string, rawArgs: Record<string, any>) => {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  logDebug('tool-call.received', {
    tool: name,
    args: previewValue(args),
    boundTarget: {
      clientId: boundClientId,
      sessionId: boundSessionId
    }
  });

  switch (name) {
    case 'get_active_target': {
      const activeTarget = await invokeCommand('Device', 'Device.getActiveTarget', normalizeTargetParams(args));
      return {
        ...activeTarget,
        ...(boundClientId !== undefined ? { clientId: boundClientId } : {}),
        ...(boundSessionId !== undefined ? { sessionId: boundSessionId } : {}),
        ...(boundClientId !== undefined || boundSessionId !== undefined
          ? {
              boundTarget: {
                ...(boundClientId !== undefined ? { clientId: boundClientId } : {}),
                ...(boundSessionId !== undefined ? { sessionId: boundSessionId } : {})
              }
            }
          : {})
      };
    }
    case 'list_clients':
      return invokeCommand('Device', 'Device.listClients', {});
    case 'list_sessions':
      return invokeCommand('Device', 'Device.listSessions', normalizeTargetParams(args));
    case 'send_cdp': {
      const method = typeof args.method === 'string' ? args.method.trim() : '';
      if (!method) {
        throw new Error('method is required');
      }
      const params =
        args.params && typeof args.params === 'object' && !Array.isArray(args.params)
          ? args.params
          : {};
      return invokeCommand('CDP', method, await resolveTargetParams(args, params));
    }
    case 'list_console_messages':
      return invokeCommand(
        'CDP',
        'Runtime.listConsole',
        await resolveTargetParams(args, {
          offset: normalizeInteger(args.offset),
          limit: normalizeInteger(args.limit),
          includeStackTraces: args.includeStackTraces === true,
          level: Array.isArray(args.level) ? args.level.filter((item: any) => typeof item === 'string') : undefined
        })
      );
    case 'list_scripts':
      return invokeCommand('CDP', 'Debugger.listScripts', await resolveTargetParams(args));
    case 'get_script_source': {
      const scriptId = typeof args.scriptId === 'string' ? args.scriptId.trim() : '';
      if (!scriptId) {
        throw new Error('scriptId is required');
      }
      return invokeCommand('CDP', 'Debugger.getScriptSource', await resolveTargetParams(args, { scriptId }));
    }
    case 'describe_dom_node': {
      const nodeId = normalizeInteger(args.nodeId);
      if (nodeId === undefined) {
        throw new Error('nodeId is required');
      }
      const depth = normalizeInteger(args.depth);
      return invokeCommand(
        'CDP',
        'DOM.describeNode',
        await resolveTargetParams(args, {
          nodeId,
          ...(depth !== undefined ? { depth } : {}),
          ...(args.pierce === true ? { pierce: true } : {})
        })
      );
    }
    case 'get_node_box_model': {
      const nodeId = normalizeInteger(args.nodeId);
      if (nodeId === undefined) {
        throw new Error('nodeId is required');
      }
      return invokeCommand('CDP', 'DOM.getBoxModel', await resolveTargetParams(args, { nodeId }));
    }
    case 'get_computed_style': {
      const nodeId = normalizeInteger(args.nodeId);
      if (nodeId === undefined) {
        throw new Error('nodeId is required');
      }
      const result = await invokeCommand(
        'CDP',
        'CSS.getComputedStyleForNode',
        await resolveTargetParams(args, { nodeId })
      );
      return compactStyleResult(result);
    }
    case 'get_matched_styles': {
      const nodeId = normalizeInteger(args.nodeId);
      if (nodeId === undefined) {
        throw new Error('nodeId is required');
      }
      return invokeCommand('CDP', 'CSS.getMatchedStylesForNode', await resolveTargetParams(args, { nodeId }));
    }
    case 'get_node_text': {
      const nodeId = normalizeInteger(args.nodeId);
      if (nodeId === undefined) {
        throw new Error('nodeId is required');
      }
      return invokeCommand('CDP', 'DOM.innerText', await resolveTargetParams(args, { nodeId }));
    }
    case 'get_node_layout_snapshot':
      return getNodeLayoutSnapshot(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: DEVTOOL_DEBUG_MCP_TOOLS
  };
});

server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const result = await handleToolCall(request.params.name, request.params.arguments || {});
    logDebug('tool-call.succeeded', {
      tool: request.params.name,
      result: previewValue(result)
    });
    return toToolResult(result);
  } catch (error) {
    logDebug('tool-call.failed', {
      tool: request.params.name,
      error: error instanceof Error ? error.message : String(error)
    });
    return toToolResult(
      {
        tool: request.params.name,
        error: error instanceof Error ? error.message : String(error)
      },
      true
    );
  }
});

const start = async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

void start().catch(error => {
  process.stderr.write(
    `[${DEVTOOL_DEBUG_MCP_SERVER_NAME}] Failed to start: ${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exit(1);
});
