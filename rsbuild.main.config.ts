import { defineConfig } from '@rsbuild/core';
import { pluginBabel } from '@rsbuild/plugin-babel';
import { RspackVirtualModulePlugin } from 'rspack-plugin-virtual-module';
import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';
import { generateMainVirtualModule } from './scripts/virtualModule';

const requireFromConfig = createRequire(__filename);

function copyCdpTools() {
  const srcPath = path.join(__dirname, 'plugins/lynx-ai-assistant/resources/cdp-tools.json');
  const destDir = path.join(__dirname, 'dist/resources');
  const destPath = path.join(destDir, 'cdp-tools.json');
  
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log('Copied cdp-tools.json to dist/resources');
}

function getCodexTargetTriple() {
  switch (process.platform) {
    case 'darwin':
      return process.arch === 'arm64' ? 'aarch64-apple-darwin' : process.arch === 'x64' ? 'x86_64-apple-darwin' : null;
    case 'linux':
    case 'android':
      return process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : process.arch === 'x64' ? 'x86_64-unknown-linux-musl' : null;
    case 'win32':
      return process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : null;
    default:
      return null;
  }
}

function getCodexPlatformPackageName(targetTriple: string) {
  switch (targetTriple) {
    case 'x86_64-unknown-linux-musl':
      return '@openai/codex-linux-x64';
    case 'aarch64-unknown-linux-musl':
      return '@openai/codex-linux-arm64';
    case 'x86_64-apple-darwin':
      return '@openai/codex-darwin-x64';
    case 'aarch64-apple-darwin':
      return '@openai/codex-darwin-arm64';
    case 'x86_64-pc-windows-msvc':
      return '@openai/codex-win32-x64';
    case 'aarch64-pc-windows-msvc':
      return '@openai/codex-win32-arm64';
    default:
      return null;
  }
}

function copyCodexSdkVendor() {
  const targetTriple = getCodexTargetTriple();
  if (!targetTriple) {
    console.warn('Skipping Codex SDK vendor copy: unsupported platform/arch');
    return;
  }

  const packageName = getCodexPlatformPackageName(targetTriple);
  if (!packageName) {
    console.warn(`Skipping Codex SDK vendor copy: no platform package for ${targetTriple}`);
    return;
  }

  try {
    const packageJsonPath = requireFromConfig.resolve(`${packageName}/package.json`);
    const vendorSourceDir = path.join(path.dirname(packageJsonPath), 'vendor', targetTriple);
    if (!fs.existsSync(vendorSourceDir)) {
      console.warn(`Skipping Codex SDK vendor copy: vendor dir missing at ${vendorSourceDir}`);
      return;
    }

    const vendorDestDir = path.join(__dirname, 'dist/resources/codex-sdk', targetTriple);
    fs.mkdirSync(path.dirname(vendorDestDir), { recursive: true });
    fs.rmSync(vendorDestDir, { recursive: true, force: true });
    fs.cpSync(vendorSourceDir, vendorDestDir, { recursive: true });
    console.log(`Copied Codex SDK vendor to dist/resources/codex-sdk/${targetTriple}`);
  } catch (error) {
    console.warn('Failed to copy Codex SDK vendor binary:', error);
  }
}

copyCdpTools();
copyCodexSdkVendor();

export default defineConfig({
  plugins: [
    pluginBabel(),
  ],
  source: {
    entry: {
      index: './src/main/index.ts',
      preload: './preload.js',
      'lynx-devtool-debug-mcp': './plugins/lynx-ai-assistant/runtime/devtool-debug-mcp-server.ts',
      'lynx-codex-sdk-sidecar': './plugins/lynx-ai-assistant/runtime/codex-sdk-sidecar.ts'
    },
    alias: {
      '@': './src'
    }
  },
  output: {
    distPath: {
      root: 'dist',
      js: '.'
    },
    target: 'node',
    cleanDistPath: false,
    filename: {
      js: '[name].js'
    },
    filenameHash: false,
    sourceMap: true,
  },
  tools: {
    rspack: {
      target: 'electron-main',
      devtool: 'source-map',
      externals: {
        'electron': 'electron',
        '@electron/remote': '@electron/remote',
        '@lynx-js/lynx-devtool-cli': '@lynx-js/lynx-devtool-cli',
        'electron-log': 'electron-log',
        'node-machine-id': 'node-machine-id'
      },
      devServer: {
        hot: true,
        liveReload: false,
        client: {
          overlay: true,
          progress: true
        },
        devMiddleware: {
          writeToDisk: true
        },
        port: 8080,
        setupMiddlewares: (middlewares, server) => {
          console.log('Dev server setup, ensuring dist files are preserved');
          return middlewares;
        },
        onListening: (server) => {
          console.log('Dev server is now listening');
        }
      },
      output: {
        clean: false
      },
      plugins: [
        new RspackVirtualModulePlugin({
          virtualModules: generateMainVirtualModule(__dirname)
        }),
      ]
    }
  }
}); 
