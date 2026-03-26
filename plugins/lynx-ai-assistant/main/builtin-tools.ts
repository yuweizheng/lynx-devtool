// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const MAX_READ_OUTPUT = 5000;
const MAX_GREP_OUTPUT = 3000;
const DEFAULT_MAX_GREP_RESULTS = 20;

export interface BuiltinToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export function getBuiltinToolDefinitions(): BuiltinToolDefinition[] {
  return [
    {
      name: 'builtin_read_file',
      description:
        'Read file content from the local filesystem. Useful for examining source code referenced in stack traces. ' +
        'Returns the file content with line numbers. Output is truncated if too large.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute or relative path to the file to read'
          },
          startLine: {
            type: 'integer',
            description: 'Start reading from this line number (1-based, inclusive). Omit to start from the beginning.'
          },
          endLine: {
            type: 'integer',
            description: 'Stop reading at this line number (1-based, inclusive). Omit to read until end.'
          }
        },
        required: ['path']
      }
    },
    {
      name: 'builtin_grep_source',
      description:
        'Search for a text pattern in files under a given directory. Useful for finding error-related code, ' +
        'configuration, or definitions. Returns matching lines with file paths and line numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The text or regex pattern to search for'
          },
          directory: {
            type: 'string',
            description: 'Directory to search in. Defaults to current working directory.'
          },
          fileGlob: {
            type: 'string',
            description: 'File glob pattern to filter (e.g., "*.ts", "*.js"). Omit to search all files.'
          },
          maxResults: {
            type: 'integer',
            description: `Maximum number of matching lines to return. Defaults to ${DEFAULT_MAX_GREP_RESULTS}.`
          }
        },
        required: ['pattern']
      }
    },
    {
      name: 'builtin_list_files',
      description:
        'List files in a directory. Useful for understanding project structure or finding relevant files.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: 'Directory to list. Defaults to current working directory.'
          },
          recursive: {
            type: 'boolean',
            description: 'Whether to list files recursively. Defaults to false.'
          },
          fileGlob: {
            type: 'string',
            description: 'File glob pattern to filter (e.g., "*.ts"). Only used when recursive is true.'
          }
        },
        required: ['directory']
      }
    }
  ];
}

function truncateOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  const half = Math.floor((maxLength - 50) / 2);
  return (
    output.substring(0, half) +
    `\n\n... [truncated ${output.length - maxLength} chars] ...\n\n` +
    output.substring(output.length - half)
  );
}

export async function executeBuiltinTool(
  name: string,
  args: Record<string, any>
): Promise<{ content: string }> {
  switch (name) {
    case 'builtin_read_file':
      return executeReadFile(args);
    case 'builtin_grep_source':
      return executeGrepSource(args);
    case 'builtin_list_files':
      return executeListFiles(args);
    default:
      throw new Error(`Unknown builtin tool: ${name}`);
  }
}

async function executeReadFile(args: Record<string, any>): Promise<{ content: string }> {
  const filePath = args.path as string;
  if (!filePath) {
    throw new Error('path is required');
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  const lines = content.split('\n');

  const startLine = Math.max(1, (args.startLine as number) || 1);
  const endLine = Math.min(lines.length, (args.endLine as number) || lines.length);

  const selectedLines = lines.slice(startLine - 1, endLine);
  const numbered = selectedLines
    .map((line, i) => `${startLine + i}: ${line}`)
    .join('\n');

  return { content: truncateOutput(numbered, MAX_READ_OUTPUT) };
}

async function executeGrepSource(args: Record<string, any>): Promise<{ content: string }> {
  const pattern = args.pattern as string;
  if (!pattern) {
    throw new Error('pattern is required');
  }

  const directory = path.resolve((args.directory as string) || process.cwd());
  const maxResults = (args.maxResults as number) || DEFAULT_MAX_GREP_RESULTS;
  const fileGlob = args.fileGlob as string | undefined;

  if (!fs.existsSync(directory)) {
    throw new Error(`Directory not found: ${directory}`);
  }

  // Use grep for searching
  let cmd = `grep -rn --max-count=${maxResults}`;
  if (fileGlob) {
    cmd += ` --include='${fileGlob}'`;
  }
  // Exclude common non-source directories
  cmd += ` --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=out --exclude-dir=dist`;
  // Escape pattern for shell
  const escapedPattern = pattern.replace(/'/g, "'\\''");
  cmd += ` '${escapedPattern}' '${directory}'`;

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    return { content: truncateOutput(output.trim(), MAX_GREP_OUTPUT) };
  } catch (e: any) {
    // grep exits with code 1 when no matches found
    if (e.status === 1) {
      return { content: 'No matches found.' };
    }
    throw new Error(`grep failed: ${e.message}`);
  }
}

async function executeListFiles(args: Record<string, any>): Promise<{ content: string }> {
  const directory = path.resolve((args.directory as string) || process.cwd());
  const recursive = (args.recursive as boolean) || false;

  if (!fs.existsSync(directory)) {
    throw new Error(`Directory not found: ${directory}`);
  }

  const files: string[] = [];
  const maxFiles = 200;

  function listDir(dir: string, depth: number): void {
    if (files.length >= maxFiles) return;
    if (depth > 5) return; // Max recursion depth

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      // Skip common non-source directories
      if (entry.isDirectory() && ['node_modules', '.git', 'out', 'dist', '.cache'].includes(entry.name)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(directory, fullPath);

      if (entry.isDirectory()) {
        files.push(relativePath + '/');
        if (recursive) {
          listDir(fullPath, depth + 1);
        }
      } else {
        files.push(relativePath);
      }
    }
  }

  listDir(directory, 0);

  let output = files.join('\n');
  if (files.length >= maxFiles) {
    output += `\n\n... [truncated, showing first ${maxFiles} entries]`;
  }

  return { content: output };
}
