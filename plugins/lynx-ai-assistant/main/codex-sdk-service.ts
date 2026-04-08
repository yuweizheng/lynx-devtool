// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import {
  CODEX_SDK_SIDECAR_ENTRY_NAME,
  CodexSDKConfig,
  CodexSDKDebugEvent,
  CodexSDKProgressEvent,
  CodexSDKRequest,
  CodexSDKResponse,
  CodexSDKSidecarInput,
  CodexSDKSidecarOutput,
  CodexSandboxMode
} from '../shared/codex-sdk-sidecar';

export type {
  CodexSDKConfig,
  CodexSDKDebugEvent,
  CodexSDKProgressEvent,
  CodexSDKRequest,
  CodexSDKResponse,
  CodexSandboxMode
} from '../shared/codex-sdk-sidecar';

export class CodexSDKService {
  private readonly defaultNodeCommand = process.env.LYNX_AI_NODE_COMMAND?.trim() || 'node';

  async run(
    request: CodexSDKRequest,
    config: CodexSDKConfig,
    callbacks?: {
      onProgress?: (event: CodexSDKProgressEvent) => void;
      onDebug?: (event: CodexSDKDebugEvent) => void;
    }
  ): Promise<CodexSDKResponse> {
    const cwd = request.cwd && fs.existsSync(request.cwd) ? request.cwd : process.cwd();
    const scriptPath = this.resolveSidecarScriptPath();
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Codex SDK sidecar entry not found: ${scriptPath}`);
    }

    const nodeCommand = this.defaultNodeCommand;
    callbacks?.onDebug?.({
      stage: 'sidecar.spawn',
      argumentsPreview: this.previewValue({
        mainNodeVersion: process.versions.node,
        electronVersion: process.versions.electron,
        execPath: process.execPath,
        nodeCommand,
        sidecarScriptPath: scriptPath,
        cwd,
        codexCommand: config.command,
        sandbox: config.sandbox,
        model: config.model
      })
    });

    const sidecarInput: CodexSDKSidecarInput = {
      request: {
        ...request,
        cwd
      },
      config
    };

    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
    env.FORCE_COLOR = '0';

    const child = spawn(nodeCommand, [scriptPath], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const stderrChunks: Buffer[] = [];
    let spawnError: Error | null = null;
    let sidecarError: Error | null = null;
    let result: CodexSDKResponse | null = null;

    child.once('error', error => {
      spawnError = error;
    });

    child.stderr?.on('data', chunk => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity
    });

    child.stdin?.write(JSON.stringify(sidecarInput));
    child.stdin?.end();

    try {
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        const payload = this.parseSidecarOutput(line);
        if (payload.type === 'progress') {
          callbacks?.onProgress?.(payload.event);
          continue;
        }
        if (payload.type === 'debug') {
          callbacks?.onDebug?.(payload.event);
          continue;
        }
        if (payload.type === 'result') {
          result = payload.response;
          continue;
        }
        sidecarError = new Error(payload.message);
      }
    } catch (error) {
      sidecarError = error instanceof Error ? error : new Error(String(error));
    }

    const { code, signal } = await exitPromise;
    if (spawnError) {
      throw new Error(`Failed to start Codex SDK sidecar via \`${nodeCommand}\`: ${spawnError.message}`);
    }
    if (sidecarError) {
      throw sidecarError;
    }
    if (code !== 0 || signal) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      throw new Error(
        `Codex SDK sidecar exited with ${detail}${stderr ? `: ${stderr}` : ''}`
      );
    }
    if (!result) {
      throw new Error('Codex SDK sidecar exited without returning a result.');
    }

    return result;
  }

  private resolveSidecarScriptPath(): string {
    return path.join(__dirname, `${CODEX_SDK_SIDECAR_ENTRY_NAME}.js`);
  }

  private parseSidecarOutput(line: string): CodexSDKSidecarOutput {
    try {
      return JSON.parse(line) as CodexSDKSidecarOutput;
    } catch (error) {
      throw new Error(
        `Failed to parse Codex SDK sidecar output: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
}
