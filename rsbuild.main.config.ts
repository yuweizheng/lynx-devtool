import { defineConfig } from '@rsbuild/core';
import { pluginBabel } from '@rsbuild/plugin-babel';
import { RspackVirtualModulePlugin } from 'rspack-plugin-virtual-module';
import * as path from 'path';
import * as fs from 'fs';
import { generateMainVirtualModule } from './scripts/virtualModule';

function copyCdpTools() {
  const srcPath = path.join(__dirname, 'plugins/lynx-ai-assistant/resources/cdp-tools.json');
  const destDir = path.join(__dirname, 'dist/resources');
  const destPath = path.join(destDir, 'cdp-tools.json');
  
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log('Copied cdp-tools.json to dist/resources');
}

copyCdpTools();

export default defineConfig({
  plugins: [
    pluginBabel(),
  ],
  source: {
    entry: {
      index: './src/main/index.ts',
      preload: './preload.js'
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