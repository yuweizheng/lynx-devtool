// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export const DEVTOOL_DEBUG_MCP_SERVER_ID = 'lynx-devtool-debug-mcp';
export const DEVTOOL_DEBUG_MCP_SERVER_NAME = 'Lynx DevTool Debug MCP';
export const DEVTOOL_DEBUG_MCP_ENTRY_NAME = 'lynx-devtool-debug-mcp';
export const DEVTOOL_DEBUG_MCP_PROXY_PATH = '/lynx-ai-assistant/debug-mcp';
export const DEVTOOL_DEBUG_MCP_PROXY_URL_ENV = 'LYNX_DEVTOOL_DEBUG_MCP_PROXY_URL';
export const DEVTOOL_DEBUG_MCP_PROXY_TOKEN_ENV = 'LYNX_DEVTOOL_DEBUG_MCP_PROXY_TOKEN';
export const DEVTOOL_DEBUG_MCP_BOUND_CLIENT_ID_ENV = 'LYNX_DEVTOOL_DEBUG_MCP_BOUND_CLIENT_ID';
export const DEVTOOL_DEBUG_MCP_BOUND_SESSION_ID_ENV = 'LYNX_DEVTOOL_DEBUG_MCP_BOUND_SESSION_ID';

export type DevtoolDebugCommandType = 'CDP' | 'Device' | 'App';

export interface DevtoolDebugProxyRequest {
  type?: DevtoolDebugCommandType;
  method: string;
  params?: Record<string, any>;
}

export interface DevtoolDebugProxyResponse {
  ok: boolean;
  result?: any;
  error?: string;
}

type JsonSchema = Record<string, any>;

const integerProperty = (description: string): JsonSchema => ({
  type: 'integer',
  description
});

const stringProperty = (description: string): JsonSchema => ({
  type: 'string',
  description
});

const booleanProperty = (description: string): JsonSchema => ({
  type: 'boolean',
  description
});

const objectSchema = (
  properties: Record<string, JsonSchema>,
  required?: string[],
  extras?: Record<string, any>
): JsonSchema => ({
  type: 'object',
  properties,
  ...(required && required.length > 0 ? { required } : {}),
  ...(extras || {})
});

export interface DevtoolDebugMCPToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const DEVTOOL_DEBUG_MCP_TOOLS: DevtoolDebugMCPToolDefinition[] = [
  {
    name: 'get_active_target',
    description:
      'Return the current Lynx DevTool selection, including clientId, sessionId, device info, and the selected session.',
    inputSchema: objectSchema({})
  },
  {
    name: 'list_clients',
    description: 'List the currently connected Lynx runtime clients that DevTool can inspect.',
    inputSchema: objectSchema({})
  },
  {
    name: 'list_sessions',
    description:
      'List the available sessions for a client. If clientId is omitted, use the current DevTool selection.',
    inputSchema: objectSchema({
      clientId: integerProperty('Optional runtime clientId. Defaults to the currently selected client.')
    })
  },
  {
    name: 'send_cdp',
    description:
      'Send an arbitrary CDP method to the active Lynx runtime target. Use when no higher-level helper fits.',
    inputSchema: objectSchema(
      {
        method: stringProperty('CDP method name, for example DOM.describeNode or CSS.getComputedStyleForNode.'),
        params: {
          type: 'object',
          description: 'CDP method params object.'
        },
        clientId: integerProperty('Optional runtime clientId override.'),
        sessionId: integerProperty('Optional runtime sessionId override.')
      },
      ['method']
    )
  },
  {
    name: 'list_console_messages',
    description:
      'Fetch live console messages from the selected runtime, with optional stack traces and severity filtering.',
    inputSchema: objectSchema({
      clientId: integerProperty('Optional runtime clientId override.'),
      sessionId: integerProperty('Optional runtime sessionId override.'),
      offset: integerProperty('Optional start offset for the result set.'),
      limit: integerProperty('Optional maximum number of console messages to return.'),
      includeStackTraces: booleanProperty('Whether to include stack traces when available.'),
      level: {
        type: 'array',
        description: 'Optional console levels to include, for example ["error", "warning"].',
        items: { type: 'string' }
      }
    })
  },
  {
    name: 'list_scripts',
    description: 'Enumerate runtime scripts for the active target so they can be mapped back to source URLs.',
    inputSchema: objectSchema({
      clientId: integerProperty('Optional runtime clientId override.'),
      sessionId: integerProperty('Optional runtime sessionId override.')
    })
  },
  {
    name: 'get_script_source',
    description: 'Fetch the JavaScript source text for a scriptId from the current runtime target.',
    inputSchema: objectSchema(
      {
        scriptId: stringProperty('The runtime scriptId to inspect.'),
        clientId: integerProperty('Optional runtime clientId override.'),
        sessionId: integerProperty('Optional runtime sessionId override.')
      },
      ['scriptId']
    )
  },
  {
    name: 'describe_dom_node',
    description: 'Describe a live DOM node by nodeId, including attributes and nearby children when available.',
    inputSchema: objectSchema(
      {
        nodeId: integerProperty('The DOM nodeId to inspect.'),
        depth: integerProperty('Optional DOM depth to include in the response.'),
        pierce: booleanProperty('Whether to traverse into nested trees when supported.'),
        clientId: integerProperty('Optional runtime clientId override.'),
        sessionId: integerProperty('Optional runtime sessionId override.')
      },
      ['nodeId']
    )
  },
  {
    name: 'get_node_box_model',
    description: 'Get the live box model for a DOM node, including content, padding, border, and margin geometry.',
    inputSchema: objectSchema(
      {
        nodeId: integerProperty('The DOM nodeId to inspect.'),
        clientId: integerProperty('Optional runtime clientId override.'),
        sessionId: integerProperty('Optional runtime sessionId override.')
      },
      ['nodeId']
    )
  },
  {
    name: 'get_computed_style',
    description: 'Get the computed style list for a DOM node from the live runtime.',
    inputSchema: objectSchema(
      {
        nodeId: integerProperty('The DOM nodeId to inspect.'),
        clientId: integerProperty('Optional runtime clientId override.'),
        sessionId: integerProperty('Optional runtime sessionId override.')
      },
      ['nodeId']
    )
  },
  {
    name: 'get_matched_styles',
    description: 'Get matched CSS rules and inline style information for a live DOM node.',
    inputSchema: objectSchema(
      {
        nodeId: integerProperty('The DOM nodeId to inspect.'),
        clientId: integerProperty('Optional runtime clientId override.'),
        sessionId: integerProperty('Optional runtime sessionId override.')
      },
      ['nodeId']
    )
  },
  {
    name: 'get_node_text',
    description: 'Get the raw inner text values for a live DOM node.',
    inputSchema: objectSchema(
      {
        nodeId: integerProperty('The DOM nodeId to inspect.'),
        clientId: integerProperty('Optional runtime clientId override.'),
        sessionId: integerProperty('Optional runtime sessionId override.')
      },
      ['nodeId']
    )
  },
  {
    name: 'get_node_layout_snapshot',
    description:
      'Collect a live layout snapshot for a nodeId by combining DOM description, box model, computed styles, matched styles, and text.',
    inputSchema: objectSchema(
      {
        nodeId: integerProperty('The DOM nodeId to inspect.'),
        depth: integerProperty('Optional DOM depth for the describeNode step.'),
        clientId: integerProperty('Optional runtime clientId override.'),
        sessionId: integerProperty('Optional runtime sessionId override.')
      },
      ['nodeId']
    )
  }
];
