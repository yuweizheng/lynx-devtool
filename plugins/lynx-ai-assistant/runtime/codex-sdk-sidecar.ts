// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as fs from 'fs';
import * as path from 'path';
import type {
  ApprovalMode,
  CodexOptions,
  ThreadEvent,
  ThreadItem,
  ThreadOptions
} from '@openai/codex-sdk';
import {
  CodexSDKConfig,
  CodexSDKDebugEvent,
  CodexSDKProgressEvent,
  CodexSDKRequest,
  CodexSDKResponse,
  CodexSDKSidecarInput,
  CodexSDKSidecarOutput,
  CodexSandboxMode
} from '../shared/codex-sdk-sidecar';

const emit = (payload: CodexSDKSidecarOutput) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

class CodexSDKRunner {
  private readonly defaultApprovalPolicy: ApprovalMode = 'never';
  private readonly defaultSandbox: CodexSandboxMode = 'read-only';

  async run(
    request: CodexSDKRequest,
    config: CodexSDKConfig,
    callbacks?: {
      onProgress?: (event: CodexSDKProgressEvent) => void;
      onDebug?: (event: CodexSDKDebugEvent) => void;
    }
  ): Promise<CodexSDKResponse> {
    const cwd = request.cwd && fs.existsSync(request.cwd) ? request.cwd : process.cwd();
    const emitProgress = (event: CodexSDKProgressEvent) => {
      try {
        callbacks?.onProgress?.(event);
      } catch {
        // Ignore stream callback failures.
      }
    };
    const emitDebug = (event: CodexSDKDebugEvent) => {
      try {
        callbacks?.onDebug?.(event);
      } catch {
        // Ignore stream callback failures.
      }
    };

    const { Codex } = await import('@openai/codex-sdk');
    const codexOptions = this.buildCodexOptions(config);
    const threadOptions = this.buildThreadOptions(config, cwd);
    emitDebug(this.buildLaunchDebugEvent(config, cwd, codexOptions, threadOptions));
    const codex = new Codex(codexOptions);
    const thread = codex.startThread(threadOptions);
    const previousTextByItem = new Map<string, string>();
    let finalResponse = '';

    try {
      const { events } = await thread.runStreamed(request.prompt);
      for await (const event of events) {
        this.emitThreadEvent(event, previousTextByItem, emitProgress, emitDebug);
        if (
          event.type === 'item.completed' &&
          event.item.type === 'mcp_tool_call' &&
          event.item.status === 'failed' &&
          event.item.error?.message === 'user cancelled MCP tool call'
        ) {
          throw new Error(
            'Codex SDK cancelled an MCP tool call before execution. The embedded session must run with approvalPolicy="never" to use MCP tools non-interactively.'
          );
        }
        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          finalResponse = event.item.text || finalResponse;
        }
        if (event.type === 'turn.failed') {
          throw new Error(event.error.message);
        }
        if (event.type === 'error') {
          throw new Error(event.message);
        }
      }
    } catch (error) {
      throw new Error(this.formatRunError(error));
    }

    if (!finalResponse) {
      finalResponse = this.findLatestAgentMessage(previousTextByItem) || 'No response';
    }

    return {
      output: finalResponse,
      threadId: thread.id
    };
  }

  private buildCodexOptions(config: CodexSDKConfig): CodexOptions {
    const options: CodexOptions = {};
    const codexPathOverride = config.command?.trim() || this.resolveBundledCodexPath();
    if (codexPathOverride) {
      options.codexPathOverride = codexPathOverride;
    }
    if (config.apiKey?.trim()) {
      options.apiKey = config.apiKey.trim();
    }
    if (config.baseURL?.trim()) {
      options.baseUrl = config.baseURL.trim();
    }
    if (config.config) {
      options.config = config.config;
    }
    options.env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
    options.env.FORCE_COLOR = '0';
    return options;
  }

  private resolveBundledCodexPath(): string | undefined {
    const targetTriple = this.getTargetTriple();
    if (!targetTriple) {
      return undefined;
    }
    const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const bundledPath = path.join(
      __dirname,
      'resources',
      'codex-sdk',
      targetTriple,
      'codex',
      binaryName
    );
    return fs.existsSync(bundledPath) ? bundledPath : undefined;
  }

  private getTargetTriple(): string | undefined {
    switch (process.platform) {
      case 'darwin':
        return process.arch === 'arm64' ? 'aarch64-apple-darwin' : process.arch === 'x64' ? 'x86_64-apple-darwin' : undefined;
      case 'linux':
      case 'android':
        return process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : process.arch === 'x64' ? 'x86_64-unknown-linux-musl' : undefined;
      case 'win32':
        return process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : undefined;
      default:
        return undefined;
    }
  }

  private buildThreadOptions(config: CodexSDKConfig, cwd: string): ThreadOptions {
    const options: ThreadOptions = {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: config.sandbox || this.defaultSandbox,
      approvalPolicy: this.defaultApprovalPolicy
    };
    if (config.model?.trim()) {
      options.model = config.model.trim();
    }
    return options;
  }

  private emitThreadEvent(
    event: ThreadEvent,
    previousTextByItem: Map<string, string>,
    emitProgress: (event: CodexSDKProgressEvent) => void,
    emitDebug: (event: CodexSDKDebugEvent) => void
  ) {
    const rawType = event.type;
    this.emitDebugThreadEvent(event, emitDebug);
    const statusMessage = this.inferStatusMessage(event);
    if (statusMessage) {
      emitProgress({
        phase: rawType === 'error' || rawType === 'turn.failed' ? 'error' : 'status',
        rawType,
        message: statusMessage
      });
    }

    const delta = this.extractTextDelta(event, previousTextByItem);
    if (delta) {
      emitProgress({
        phase: 'delta',
        rawType,
        text: delta
      });
    }

    const snapshot = this.extractTextSnapshot(event, previousTextByItem);
    if (snapshot) {
      emitProgress({
        phase: 'snapshot',
        rawType,
        text: snapshot
      });
    }
  }

  private emitDebugThreadEvent(
    event: ThreadEvent,
    emitDebug: (event: CodexSDKDebugEvent) => void
  ): void {
    if (event.type === 'turn.failed') {
      emitDebug({
        stage: 'turn.failed',
        rawType: event.type,
        error: event.error.message
      });
      return;
    }

    if (event.type === 'error') {
      emitDebug({
        stage: 'thread.error',
        rawType: event.type,
        error: event.message
      });
      return;
    }

    if (
      (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') &&
      event.item.type === 'mcp_tool_call'
    ) {
      emitDebug({
        stage: 'mcp_tool_call',
        rawType: event.type,
        itemType: event.item.type,
        server: event.item.server,
        tool: event.item.tool,
        status: event.item.status,
        argumentsPreview: this.previewValue(event.item.arguments),
        resultPreview: event.item.result
          ? this.previewValue(event.item.result.structured_content ?? event.item.result.content)
          : undefined,
        error: event.item.error?.message
      });
    }
  }

  private buildLaunchDebugEvent(
    config: CodexSDKConfig,
    cwd: string,
    codexOptions: CodexOptions,
    threadOptions: ThreadOptions
  ): CodexSDKDebugEvent {
    const configObject =
      config.config && typeof config.config === 'object' && !Array.isArray(config.config)
        ? config.config
        : undefined;
    const mcpServers =
      configObject?.mcp_servers &&
      typeof configObject.mcp_servers === 'object' &&
      !Array.isArray(configObject.mcp_servers)
        ? Object.keys(configObject.mcp_servers as Record<string, unknown>)
        : [];

    return {
      stage: 'sdk.launch',
      argumentsPreview: this.previewValue({
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron,
        execPath: process.execPath,
        cwd,
        codexPathOverride: codexOptions.codexPathOverride,
        sandboxMode: threadOptions.sandboxMode,
        approvalPolicy: threadOptions.approvalPolicy,
        model: threadOptions.model,
        skipGitRepoCheck: threadOptions.skipGitRepoCheck,
        mcpServerIds: mcpServers,
        expectedCliArgs: this.buildExpectedCliArgs(codexOptions, threadOptions),
        usesBundledCodex: !config.command?.trim() && codexOptions.codexPathOverride === this.resolveBundledCodexPath()
      })
    };
  }

  private buildExpectedCliArgs(
    codexOptions: CodexOptions,
    threadOptions: ThreadOptions
  ): string[] {
    const args = ['exec', '--experimental-json'];

    if (codexOptions.baseUrl) {
      args.push('--config', `openai_base_url=${codexOptions.baseUrl}`);
    }
    if (threadOptions.model) {
      args.push('--model', threadOptions.model);
    }
    if (threadOptions.sandboxMode) {
      args.push('--sandbox', threadOptions.sandboxMode);
    }
    if (threadOptions.workingDirectory) {
      args.push('--cd', threadOptions.workingDirectory);
    }
    if (threadOptions.additionalDirectories?.length) {
      for (const dir of threadOptions.additionalDirectories) {
        args.push('--add-dir', dir);
      }
    }
    if (threadOptions.skipGitRepoCheck) {
      args.push('--skip-git-repo-check');
    }
    if (threadOptions.approvalPolicy) {
      args.push('--config', `approval_policy="${threadOptions.approvalPolicy}"`);
    }

    return args;
  }

  private inferStatusMessage(event: ThreadEvent): string {
    switch (event.type) {
      case 'thread.started':
        return 'Connected to the external Codex SDK sidecar.';
      case 'turn.started':
        return 'Reading your request and planning the next step.';
      case 'turn.completed':
        return 'Finished this Codex pass.';
      case 'turn.failed':
        return event.error.message;
      case 'error':
        return event.message;
      case 'item.started':
        return this.describeItemLifecycle(event.item, 'started');
      case 'item.updated':
        return this.describeItemLifecycle(event.item, 'updated');
      case 'item.completed':
        return this.describeItemLifecycle(event.item, 'completed');
      default:
        return '';
    }
  }

  private describeItemLifecycle(
    item: ThreadItem,
    lifecycle: 'started' | 'updated' | 'completed'
  ): string {
    switch (item.type) {
      case 'command_execution': {
        const command = this.shortenInlineText(item.command || 'workspace command');
        if (lifecycle === 'started') {
          return `Running \`${command}\` in the workspace...`;
        }
        if (lifecycle === 'completed') {
          return item.status === 'failed'
            ? `Running \`${command}\` failed.`
            : `Finished running \`${command}\`.`;
        }
        return item.aggregated_output?.trim()
          ? `Streaming output from \`${command}\`.`
          : '';
      }
      case 'mcp_tool_call': {
        const toolLabel = item.server ? `${item.server}.${item.tool}` : item.tool;
        if (lifecycle === 'started') {
          return `Consulting \`${toolLabel}\`...`;
        }
        if (lifecycle === 'completed') {
          return item.status === 'failed'
            ? `The \`${toolLabel}\` lookup failed.`
            : `Finished consulting \`${toolLabel}\`.`;
        }
        return `Waiting for \`${toolLabel}\`...`;
      }
      case 'file_change': {
        const changedFiles = item.changes.map(change => change.path).filter(Boolean);
        const filePreview = this.shortenInlineText(changedFiles.slice(0, 3).join(', ') || 'workspace files');
        if (lifecycle === 'started') {
          return `Preparing edits for \`${filePreview}\`...`;
        }
        if (lifecycle === 'completed') {
          return item.status === 'failed'
            ? `Applying the edit for \`${filePreview}\` failed.`
            : `Applied changes to \`${filePreview}\`.`;
        }
        return '';
      }
      case 'todo_list': {
        const nextTodo = item.items.find(todo => !todo.completed)?.text || item.items[0]?.text;
        if (!nextTodo) {
          return '';
        }
        if (lifecycle === 'completed') {
          return 'Wrapped up the current plan.';
        }
        return `Working plan: ${this.shortenInlineText(nextTodo, 96)}`;
      }
      case 'reasoning':
        return item.text ? `Thinking: ${this.shortenInlineText(item.text, 96)}` : 'Thinking through the next step...';
      case 'web_search':
        return lifecycle === 'completed'
          ? `Finished searching for \`${this.shortenInlineText(item.query, 72)}\`.`
          : `Searching for \`${this.shortenInlineText(item.query, 72)}\`...`;
      case 'agent_message':
        return lifecycle === 'completed' ? 'Finished drafting the current response.' : 'Drafting the response...';
      case 'error':
        return item.message;
      default:
        return '';
    }
  }

  private extractTextDelta(event: ThreadEvent, previousTextByItem: Map<string, string>): string {
    const item = this.getAgentTextItem(event);
    if (!item) {
      return '';
    }
    const currentText = item.text || '';
    const previousText = previousTextByItem.get(item.id) || '';
    previousTextByItem.set(item.id, currentText);
    if (!currentText) {
      return '';
    }
    if (currentText.startsWith(previousText)) {
      return currentText.slice(previousText.length);
    }
    return currentText === previousText ? '' : currentText;
  }

  private extractTextSnapshot(event: ThreadEvent, previousTextByItem: Map<string, string>): string {
    const item = this.getAgentTextItem(event);
    if (!item?.text) {
      return '';
    }
    previousTextByItem.set(item.id, item.text);
    return item.text;
  }

  private getAgentTextItem(
    event: ThreadEvent
  ): Extract<ThreadItem, { type: 'agent_message' }> | null {
    if (
      (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') &&
      event.item.type === 'agent_message'
    ) {
      return event.item;
    }
    return null;
  }

  private findLatestAgentMessage(previousTextByItem: Map<string, string>): string {
    const values = Array.from(previousTextByItem.values()).filter(Boolean);
    return values.length > 0 ? values[values.length - 1] : '';
  }

  private formatRunError(error: unknown): string {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const majorNodeVersion = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
    if (majorNodeVersion < 18) {
      return `${baseMessage} Current runtime is Node ${process.versions.node}; Codex SDK officially requires Node 18+.`;
    }
    return baseMessage;
  }

  private previewValue(value: unknown, maxLength: number = 600): string {
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
  }

  private shortenInlineText(text: string, maxLength: number = 72): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength - 1)}...`;
  }
}

const main = async () => {
  try {
    const inputText = await readStdin();
    const input = (inputText ? JSON.parse(inputText) : {}) as CodexSDKSidecarInput;
    const runner = new CodexSDKRunner();
    const response = await runner.run(input.request, input.config, {
      onProgress: event => emit({ type: 'progress', event }),
      onDebug: event => emit({ type: 'debug', event })
    });
    emit({ type: 'result', response });
  } catch (error) {
    emit({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    process.exitCode = 1;
  }
};

void main();
