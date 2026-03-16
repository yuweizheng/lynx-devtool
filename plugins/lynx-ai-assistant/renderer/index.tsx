// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { definePlugin } from '@lynx-js/devtool-plugin-core/renderer';
import React from 'react';
import { AIAssistantBridgeType } from '../bridge';
import { AIAssistantView } from './components/AIAssistantView';

export default definePlugin<AIAssistantBridgeType>((context) => {
  // Add listener for CDP commands from Main
  context.addPluginEventListener('EXECUTE_CDP_COMMAND', async (event) => {
    const { method, params } = event.params;
    try {
      const result = await context.debugDriver.sendCustomMessageAsync({
        type: 'CDP',
        params: { method, params }
      });
      return result;
    } catch (error) {
      console.error('[AI Assistant] CDP Command Failed:', error);
      throw error;
    }
  });

  const Index: React.FC = () => {
    return <AIAssistantView context={context} />;
  };

  return Index;
}); 