// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { definePlugin } from '@lynx-js/devtool-plugin-core/renderer';
import { ERemoteDebugDriverExternalEvent, SocketEvents } from '@lynx-js/remote-debug-driver';
import React from 'react';
import { AIAssistantBridgeType } from '../bridge';
import { AIAssistantView } from './components/AIAssistantView';

export default definePlugin<AIAssistantBridgeType>((context) => {
  // #region debug-point
  const reportDbg = (payload: Record<string, any>) => {
    try {
      void fetch('http://127.0.0.1:17777/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'lynx-ai-assistant-device-tools',
          runId: 'pre-fix',
          hypothesisId: payload.hypothesisId ?? 'H?',
          msg: payload.msg ?? 'ai-assistant',
          ts: Date.now(),
          data: payload.data ?? payload
        })
      });
    } catch (_) {}
  };
  // #endregion debug-point

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  const normalizeParams = (params: any) => {
    if (params && typeof params === 'object') return params;
    if (params === undefined || params === null) return {};
    return { clientId: params };
  };

  const toClientIdNumber = (value: any): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && /^\d+$/.test(value.trim())) return Number(value.trim());
    return undefined;
  };

  const extractCdpMessage = (
    socketEvent: any,
    expectedClientId?: number,
    expectedSessionId?: number
  ): { method?: string; params?: any; sessionId?: number } | null => {
    if (!socketEvent || socketEvent.event !== SocketEvents.Customized) return null;
    const type = socketEvent.data?.type;
    if (type !== 'CDP') return null;
    const data = socketEvent.data?.data ?? {};
    if (expectedClientId !== undefined && data.client_id !== expectedClientId && socketEvent.data?.sender !== expectedClientId) {
      return null;
    }
    if (expectedSessionId !== undefined && data.session_id !== expectedSessionId) return null;
    let message = data.message;
    if (message === undefined) {
      message = data;
    } else if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch {
        return null;
      }
    }
    if (!message || typeof message !== 'object') return null;
    return { method: (message as any).method, params: (message as any).params, sessionId: data.session_id };
  };

  const listScripts = async (driver: any, clientId: number, sessionId: number) => {
    await driver.sendCustomMessageAsync({
      type: 'CDP',
      clientId,
      sessionId,
      params: { method: 'Debugger.enable', params: {} }
    });

    const scripts: Array<{ scriptId: string; url?: string }> = [];
    let lastHit = Date.now();
    const start = Date.now();

    const listener = (socketEvent: any) => {
      const msg = extractCdpMessage(socketEvent, clientId, sessionId);
      if (msg?.method === 'Debugger.scriptParsed' && msg.params?.scriptId) {
        scripts.push({ scriptId: String(msg.params.scriptId), url: msg.params.url });
        lastHit = Date.now();
      }
    };

    await driver.on(ERemoteDebugDriverExternalEvent.All, listener);
    try {
      const idleTimeoutMs = 200;
      const maxTotalMs = 2000;
      while (Date.now() - start < maxTotalMs) {
        await sleep(50);
        if (scripts.length > 0 && Date.now() - lastHit > idleTimeoutMs) {
          break;
        }
      }
    } finally {
      driver.off(ERemoteDebugDriverExternalEvent.All, listener);
    }

    return scripts;
  };

  const listConsole = async (
    driver: any,
    clientId: number,
    sessionId: number,
    opts: { offset?: number; limit?: number; includeStackTraces?: boolean; level?: string[] }
  ) => {
    const offset = typeof opts.offset === 'number' ? opts.offset : 0;
    const limit = typeof opts.limit === 'number' ? opts.limit : 100;
    const includeStackTraces = opts.includeStackTraces === true;
    const level = Array.isArray(opts.level) && opts.level.length > 0 ? opts.level : ['info', 'log', 'warning', 'error'];

    await driver.sendCustomMessageAsync({
      type: 'CDP',
      clientId,
      sessionId,
      params: { method: 'Page.enable', params: {} }
    });
    await driver.sendCustomMessageAsync({
      type: 'CDP',
      clientId,
      sessionId,
      params: { method: 'Runtime.enable', params: {} }
    });

    const messages: any[] = [];
    let lastHit = Date.now();
    const start = Date.now();

    const listener = (socketEvent: any) => {
      const msg = extractCdpMessage(socketEvent, clientId, sessionId);
      if (msg?.method === 'Runtime.consoleAPICalled' && msg.params) {
        messages.push(msg.params);
        lastHit = Date.now();
      }
    };

    await driver.on(ERemoteDebugDriverExternalEvent.All, listener);
    try {
      const idleTimeoutMs = 500;
      const maxTotalMs = 5000;
      while (Date.now() - start < maxTotalMs) {
        await sleep(50);
        if (messages.length > 0 && Date.now() - lastHit > idleTimeoutMs) {
          break;
        }
      }
    } finally {
      driver.off(ERemoteDebugDriverExternalEvent.All, listener);
    }

    return messages
      .filter((msg) => level.includes(msg.type))
      .slice(offset, offset + limit)
      .map(({ args, type, url, stackTrace }) => ({
        type,
        text: Array.isArray(args) ? args.map((i: any) => i?.value).join(' ') : '',
        url,
        stackTrace: includeStackTraces || type === 'error' ? stackTrace : undefined
      }));
  };

  const takeScreenshot = async (driver: any, clientId: number, sessionId: number) => {
    let frameData: string | undefined;
    let screencastSessionId: number | undefined;
    const listener = (socketEvent: any) => {
      const msg = extractCdpMessage(socketEvent, clientId, sessionId);
      if (msg?.method === 'Page.screencastFrame' && msg.params?.data) {
        frameData = msg.params.data;
        screencastSessionId = msg.params.sessionId;
      }
    };

    await driver.on(ERemoteDebugDriverExternalEvent.All, listener);
    try {
      await driver.sendCustomMessageAsync({
        type: 'CDP',
        clientId,
        sessionId,
        params: { method: 'Page.startScreencast', params: { format: 'jpeg', quality: 80, mode: 'lynxview' } }
      });

      const start = Date.now();
      while (!frameData && Date.now() - start < 10000) {
        await sleep(50);
      }

      if (frameData && screencastSessionId !== undefined) {
        driver.sendCustomMessage({
          type: 'CDP',
          clientId,
          sessionId,
          params: { method: 'Page.screencastFrameAck', params: { sessionId: screencastSessionId } }
        });
      }

      if (!frameData) {
        throw new Error('Failed to capture screenshot, no Page.screencastFrame event received within 10 seconds.');
      }

      return { data: frameData, mimeType: 'image/jpeg' };
    } finally {
      try {
        await driver.sendCustomMessageAsync({
          type: 'CDP',
          clientId,
          sessionId,
          params: { method: 'Page.stopScreencast', params: {} }
        });
      } catch {}
      driver.off(ERemoteDebugDriverExternalEvent.All, listener);
    }
  };

  const handleDeviceMethod = async (driver: any, method: string, rawParams: any): Promise<any> => {
    const params = normalizeParams(rawParams);
    // #region debug-point
    reportDbg({
      hypothesisId: 'H1',
      msg: 'handleDeviceMethod.enter',
      data: {
        method,
        paramsType: typeof rawParams,
        paramsKeys: params ? Object.keys(params) : [],
        hasGetRemoteDebugDriver: typeof driver?.getRemoteDebugDriver === 'function',
        driverKeys: driver ? Object.keys(driver) : []
      }
    });
    // #endregion debug-point

    switch (method) {
      case 'Device.listDevices': {
        const store = context.getStore(context.useConnection);
        const deviceList = store?.deviceList ?? [];
        // #region debug-point
        reportDbg({
          hypothesisId: 'H1',
          msg: 'Device.listDevices.store.shape',
          data: { deviceListLen: deviceList.length }
        });
        // #endregion debug-point
        return deviceList
          .map((d: any) => d?.info?.did ?? (d?.clientId !== undefined ? String(d.clientId) : undefined))
          .filter(Boolean);
      }
      case 'Device.listClients': {
        const store = context.getStore(context.useConnection);
        const deviceList = store?.deviceList ?? [];
        // #region debug-point
        reportDbg({
          hypothesisId: 'H1',
          msg: 'Device.listClients.store.shape',
          data: { deviceListLen: deviceList.length }
        });
        // #endregion debug-point
        return deviceList.map((d: any) => ({
          id: d?.clientId !== undefined ? String(d.clientId) : undefined,
          clientId: d?.clientId,
          info: d?.info
        }));
      }
      case 'Device.listSessions': {
        const clientIdNum =
          toClientIdNumber(params.clientId) ??
          toClientIdNumber(params.client_id) ??
          toClientIdNumber(driver.getSelectClientId?.());
        if (clientIdNum === undefined) {
          throw new Error('No clientId provided or selected');
        }
        driver.listSessions?.(clientIdNum);
        await sleep(600);
        const store = context.getStore(context.useConnection);
        const sessions = store?.deviceInfoMap?.[clientIdNum]?.sessions ?? [];
        // #region debug-point
        reportDbg({
          hypothesisId: 'H1',
          msg: 'Device.listSessions.store.result',
          data: { clientIdNum, sessionsLen: sessions.length }
        });
        // #endregion debug-point
        return sessions;
      }
      case 'Device.openPage': {
        const clientIdNum =
          toClientIdNumber(params.clientId) ??
          toClientIdNumber(params.client_id) ??
          toClientIdNumber(driver.getSelectClientId?.());
        if (clientIdNum === undefined) {
          throw new Error('No clientId provided or selected');
        }
        driver.setSelectClientId?.(clientIdNum);
        return driver.sendMessageToApp?.('App.openPage', { url: params.url });
      }
      case 'Device.closePage': {
        const clientIdNum =
          toClientIdNumber(params.clientId) ??
          toClientIdNumber(params.client_id) ??
          toClientIdNumber(driver.getSelectClientId?.());
        if (clientIdNum === undefined) {
          throw new Error('No clientId provided or selected');
        }
        driver.setSelectClientId?.(clientIdNum);
        return driver.sendMessageToApp?.('App.closePage', {});
      }
      default:
        throw new Error(`Unknown Device method: ${method}`);
    }
  };

  context.addPluginEventListener('EXECUTE_CDP_COMMAND', async (event) => {
    const { method, params, type = 'CDP' } = event.params;
    const driver = context.debugDriver;
    
    try {
      // #region debug-point
      reportDbg({
        hypothesisId: 'H2',
        msg: 'EXECUTE_CDP_COMMAND.received',
        data: { type, method, paramsKeys: params ? Object.keys(params) : [], hasDriver: !!driver }
      });
      // #endregion debug-point
      if (type === 'Device') {
        const result = await handleDeviceMethod(driver, method, params);
        return result;
      }

      const normalizedParams = normalizeParams(params);
      const clientIdNum =
        toClientIdNumber((normalizedParams as any).clientId) ??
        toClientIdNumber((normalizedParams as any).client_id) ??
        toClientIdNumber(driver.getSelectClientId?.());
      const sessionId =
        (normalizedParams as any).sessionId ?? (normalizedParams as any).session_id ?? driver.getSelectSessionId?.();

      const messageParams = { ...(normalizedParams as any) };
      delete (messageParams as any).clientId;
      delete (messageParams as any).client_id;
      delete (messageParams as any).sessionId;
      delete (messageParams as any).session_id;

      if (type === 'CDP') {
        if (clientIdNum === undefined || sessionId === undefined) {
          throw new Error('No clientId/sessionId provided or selected');
        }
        if (method === 'Debugger.listScripts') {
          return await listScripts(driver, clientIdNum, sessionId);
        }
        if (method === 'Runtime.listConsole') {
          return await listConsole(driver, clientIdNum, sessionId, messageParams);
        }
        if (method === 'Page.takeScreenshot') {
          return await takeScreenshot(driver, clientIdNum, sessionId);
        }
      }

      const result = await driver.sendCustomMessageAsync({
        type,
        clientId: clientIdNum,
        sessionId,
        params: { method, params: messageParams }
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
