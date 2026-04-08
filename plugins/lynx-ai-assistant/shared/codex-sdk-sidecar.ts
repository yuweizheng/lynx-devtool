// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { CodexConfigObject, SandboxMode } from '@openai/codex-sdk';

export const CODEX_SDK_SIDECAR_ENTRY_NAME = 'lynx-codex-sdk-sidecar';

export type CodexSandboxMode = SandboxMode;

export interface CodexSDKConfig {
  command?: string;
  model?: string;
  profile?: string;
  sandbox?: CodexSandboxMode;
  apiKey?: string;
  baseURL?: string;
  config?: CodexConfigObject;
}

export interface CodexSDKRequest {
  prompt: string;
  cwd?: string;
}

export interface CodexSDKResponse {
  output: string;
  threadId?: string | null;
}

export interface CodexSDKProgressEvent {
  phase: 'status' | 'delta' | 'snapshot' | 'error';
  rawType?: string;
  message?: string;
  text?: string;
}

export interface CodexSDKDebugEvent {
  stage: string;
  rawType?: string;
  itemType?: string;
  server?: string;
  tool?: string;
  status?: string;
  argumentsPreview?: string;
  resultPreview?: string;
  error?: string;
}

export interface CodexSDKSidecarInput {
  request: CodexSDKRequest;
  config: CodexSDKConfig;
}

export type CodexSDKSidecarOutput =
  | {
      type: 'progress';
      event: CodexSDKProgressEvent;
    }
  | {
      type: 'debug';
      event: CodexSDKDebugEvent;
    }
  | {
      type: 'result';
      response: CodexSDKResponse;
    }
  | {
      type: 'error';
      message: string;
      stack?: string;
    };
