[OPEN] Debug session: console-scripts-payload

# Problem

Console 报错分析链路中，`ConsoleViewMessage.ts` 已构造 `scripts` 字段，但未成功传递到 `ai-service.ts`。

# Hypotheses

1. DevTools Frontend 发出的 `postMessage` 中已包含 `scripts`，但跨 iframe/parent 传输时被丢失。
2. `AIAssistantView.tsx` 收到请求后未正确透传 `scripts` 到 `asyncBridge.analyzeConsoleError`。
3. `main/index.ts` 的 bridge 收到 `scripts`，但调用 `aiService.analyzeConsoleError` 时字段丢失。
4. `ai-service.ts` 收到了 `scripts`，但没有进入最终发送给模型的上下文拼接。
5. `ConsoleViewMessage.ts` 取到的 `debuggerModel?.scripts()` 本身为空，导致后续链路看起来像“没传过去”。

# Plan

1. 在 Frontend、Renderer、Main、AI Service 四段链路分别增加最小化终端埋点。
2. 复现一次 Console Insight 请求。
3. 用日志确认 `scripts` 在哪一段丢失。
4. 基于证据做最小修复并验证。
