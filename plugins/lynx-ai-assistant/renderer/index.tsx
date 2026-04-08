// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { definePlugin } from '@lynx-js/devtool-plugin-core/renderer';
import { ERemoteDebugDriverExternalEvent, SocketEvents } from '@lynx-js/remote-debug-driver';
import React from 'react';
import { AIAssistantBridgeType } from '../bridge';
import { AIAssistantView } from './components/AIAssistantView';

export default definePlugin<AIAssistantBridgeType>((context) => {
  const reportDbg = (payload: Record<string, any>) => {
    try {
      const preview =
        payload && typeof payload === 'object'
          ? JSON.stringify(
              {
                hypothesisId: payload.hypothesisId ?? 'H?',
                msg: payload.msg ?? 'ai-assistant',
                location: payload.location,
                data: payload.data
              },
              null,
              0
            )
          : String(payload);
      void context.asyncBridge.debugLog({
        hypothesisId: payload.hypothesisId ?? 'H?',
        msg: payload.msg ?? 'ai-assistant',
        location: payload.location,
        data: payload.data
      });
      console.log('[AI dbg][renderer]', preview);
    } catch (_) {}
  };

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
    const hasClientIdentity = data.client_id !== undefined || socketEvent.data?.sender !== undefined;
    if (
      expectedClientId !== undefined &&
      hasClientIdentity &&
      data.client_id !== expectedClientId &&
      socketEvent.data?.sender !== expectedClientId
    ) {
      // #region debug-point B:extract-client-filter
      reportDbg({
        hypothesisId: 'B',
        location: 'renderer/index.tsx:55',
        msg: '[DEBUG] extractCdpMessage filtered by client identity',
        data: {
          expectedClientId,
          dataClientId: data.client_id,
          sender: socketEvent.data?.sender,
          expectedSessionId,
          dataSessionId: data.session_id
        }
      });
      // #endregion
      return null;
    }
    if (expectedSessionId !== undefined && data.session_id !== expectedSessionId) {
      // #region debug-point B:extract-session-filter
      reportDbg({
        hypothesisId: 'B',
        location: 'renderer/index.tsx:63',
        msg: '[DEBUG] extractCdpMessage filtered by session identity',
        data: {
          expectedClientId,
          dataClientId: data.client_id,
          sender: socketEvent.data?.sender,
          expectedSessionId,
          dataSessionId: data.session_id
        }
      });
      // #endregion
      return null;
    }
    let message = data.message;
    if (message === undefined) {
      message = data;
    } else if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch {
        // #region debug-point B:extract-json-parse
        reportDbg({
          hypothesisId: 'B',
          location: 'renderer/index.tsx:78',
          msg: '[DEBUG] extractCdpMessage failed to parse message json',
          data: {
            expectedClientId,
            expectedSessionId,
            rawType: typeof data.message,
            rawPreview: String(data.message).slice(0, 300)
          }
        });
        // #endregion
        return null;
      }
    }
    if (!message || typeof message !== 'object') return null;
    if ((message as any).method?.startsWith?.('Debugger.')) {
      // #region debug-point B:extract-debugger-method
      reportDbg({
        hypothesisId: 'B',
        location: 'renderer/index.tsx:91',
        msg: '[DEBUG] extractCdpMessage accepted debugger event',
        data: {
          expectedClientId,
          expectedSessionId,
          method: (message as any).method,
          dataClientId: data.client_id,
          sender: socketEvent.data?.sender,
          dataSessionId: data.session_id
        }
      });
      // #endregion
    }
    return { method: (message as any).method, params: (message as any).params, sessionId: data.session_id };
  };

  const listScripts = async (driver: any, clientId: number, sessionId: number) => {
    const scripts: Array<{ scriptId: string; url?: string }> = [];
    const seenScriptIds = new Set<string>();
    let lastHit = Date.now();
    const start = Date.now();
    let reloadAttempted = false;

    const waitForScriptParsed = async (maxTotalMs: number) => {
      const waitStart = Date.now();
      const idleTimeoutMs = 500;
      while (Date.now() - waitStart < maxTotalMs) {
        await sleep(50);
        if (scripts.length > 0 && Date.now() - lastHit > idleTimeoutMs) {
          break;
        }
      }
    };

    // #region debug-point A:listScripts-start
    reportDbg({
      hypothesisId: 'A',
      location: 'renderer/index.tsx:107',
      msg: '[DEBUG] listScripts started',
      data: { clientId, sessionId }
    });
    // #endregion

    const listener = (socketEvent: any) => {
      if (socketEvent?.event === SocketEvents.Customized && socketEvent?.data?.type === 'CDP') {
        // #region debug-point C:listScripts-raw-event
        reportDbg({
          hypothesisId: 'C',
          location: 'renderer/index.tsx:117',
          msg: '[DEBUG] listScripts saw raw customized CDP event',
          data: {
            event: socketEvent?.event,
            sender: socketEvent?.data?.sender,
            dataClientId: socketEvent?.data?.data?.client_id,
            dataSessionId: socketEvent?.data?.data?.session_id,
            messageType: typeof socketEvent?.data?.data?.message
          }
        });
        // #endregion
      }
      const msg = extractCdpMessage(socketEvent, clientId, sessionId);
      if (msg?.method === 'Debugger.scriptParsed' && msg.params?.scriptId) {
        const scriptId = String(msg.params.scriptId);
        if (seenScriptIds.has(scriptId)) {
          return;
        }
        seenScriptIds.add(scriptId);
        scripts.push({ scriptId, url: msg.params.url });
        lastHit = Date.now();
        // #region debug-point A:listScripts-scriptParsed
        reportDbg({
          hypothesisId: 'A',
          location: 'renderer/index.tsx:133',
          msg: '[DEBUG] listScripts captured Debugger.scriptParsed',
          data: {
            clientId,
            sessionId,
            scriptId,
            url: msg.params.url,
            totalScripts: scripts.length
          }
        });
        // #endregion
      }
    };

    await driver.on(ERemoteDebugDriverExternalEvent.All, listener);
    try {
      // #region debug-point D:listScripts-before-enable
      reportDbg({
        hypothesisId: 'D',
        location: 'renderer/index.tsx:149',
        msg: '[DEBUG] listScripts sending Debugger.enable',
        data: { clientId, sessionId }
      });
      // #endregion
      const enableResult = await driver.sendCustomMessageAsync({
        type: 'CDP',
        clientId,
        sessionId,
        params: { method: 'Debugger.enable', params: {} }
      });
      // #region debug-point D:listScripts-enable-result
      reportDbg({
        hypothesisId: 'D',
        location: 'renderer/index.tsx:160',
        msg: '[DEBUG] listScripts received Debugger.enable result',
        data: {
          clientId,
          sessionId,
          resultType: typeof enableResult,
          resultKeys: enableResult && typeof enableResult === 'object' ? Object.keys(enableResult).slice(0, 10) : [],
          resultPreview: (() => {
            try {
              return JSON.stringify(enableResult).slice(0, 500);
            } catch {
              return String(enableResult);
            }
          })()
        }
      });
      // #endregion

      await waitForScriptParsed(3000);

      if (scripts.length === 0) {
        reloadAttempted = true;
        // #region debug-point A:listScripts-reload-retry
        reportDbg({
          hypothesisId: 'A',
          location: 'renderer/index.tsx:171',
          msg: '[DEBUG] listScripts retrying once with internal Page.reload',
          data: {
            clientId,
            sessionId
          }
        });
        // #endregion
        const reloadResult = await driver.sendCustomMessageAsync({
          type: 'CDP',
          clientId,
          sessionId,
          params: { method: 'Page.reload', params: { ignoreCache: true } }
        });
        // #region debug-point A:listScripts-reload-result
        reportDbg({
          hypothesisId: 'A',
          location: 'renderer/index.tsx:184',
          msg: '[DEBUG] listScripts received internal Page.reload result',
          data: {
            clientId,
            sessionId,
            resultType: typeof reloadResult,
            resultKeys: reloadResult && typeof reloadResult === 'object' ? Object.keys(reloadResult).slice(0, 10) : [],
            resultPreview: (() => {
              try {
                return JSON.stringify(reloadResult).slice(0, 500);
              } catch {
                return String(reloadResult);
              }
            })()
          }
        });
        // #endregion
        lastHit = Date.now();
        await waitForScriptParsed(3000);
      }
    } finally {
      driver.off(ERemoteDebugDriverExternalEvent.All, listener);
    }

    if (scripts.length === 0) {
      // #region debug-point A:listScripts-empty
      reportDbg({
        hypothesisId: 'A',
        location: 'renderer/index.tsx:184',
        msg: '[DEBUG] listScripts finished without scriptParsed events',
        data: {
          clientId,
          sessionId,
          elapsedMs: Date.now() - start,
          reloadAttempted
        }
      });
      // #endregion
      return {
        scripts: [],
        note: reloadAttempted
          ? 'No Debugger.scriptParsed events were captured for the current clientId/sessionId, even after one internal Page.reload retry. This does not necessarily mean the session is invalid. Do not call Page.reload again; verify the current target context instead.'
          : 'No Debugger.scriptParsed events were captured for the current clientId/sessionId within the timeout window. The tool has not retried yet.'
      };
    }

    // #region debug-point A:listScripts-success
    reportDbg({
      hypothesisId: 'A',
      location: 'renderer/index.tsx:199',
      msg: '[DEBUG] listScripts finished with scripts',
      data: {
        clientId,
        sessionId,
        totalScripts: scripts.length,
        reloadAttempted
      }
    });
    // #endregion
    return {
      scripts,
      reloadAttempted
    };
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
      case 'Device.getActiveTarget': {
        const store = context.getStore(context.useConnection);
        const selectedDevice = store?.selectedDevice;
        const deviceList = store?.deviceList ?? [];
        const deviceInfoMap = store?.deviceInfoMap ?? {};
        const clientIdNum =
          toClientIdNumber(params.clientId) ??
          toClientIdNumber(params.client_id) ??
          toClientIdNumber(selectedDevice?.clientId) ??
          toClientIdNumber(driver.getSelectClientId?.());
        const explicitSessionId =
          normalizeParams(params).sessionId ??
          normalizeParams(params).session_id ??
          driver.getSelectSessionId?.();
        const deviceInfo = clientIdNum !== undefined ? deviceInfoMap?.[clientIdNum] : undefined;
        const sessions = Array.isArray(deviceInfo?.sessions) ? deviceInfo.sessions : [];
        const selectedSession =
          explicitSessionId !== undefined
            ? sessions.find((session: any) => session?.session_id === explicitSessionId) || deviceInfo?.selectedSession
            : deviceInfo?.selectedSession;
        const device =
          clientIdNum !== undefined
            ? deviceList.find((item: any) => item?.clientId === clientIdNum) || (selectedDevice?.clientId === clientIdNum ? selectedDevice : undefined)
            : selectedDevice;

        return {
          clientId: clientIdNum,
          sessionId: selectedSession?.session_id,
          device,
          session: selectedSession,
          sessions
        };
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
      reportDbg({
        hypothesisId: 'H2',
        msg: 'EXECUTE_CDP_COMMAND.failed',
        data: {
          type,
          method,
          paramsKeys: params ? Object.keys(params) : [],
          error: error instanceof Error ? error.message : String(error)
        }
      });
      console.error('[AI Assistant] CDP Command Failed:', error);
      throw error;
    }
  });

  const Index: React.FC = () => {
    return <AIAssistantView context={context} />;
  };

  return Index;
}); 
