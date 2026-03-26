# [OPEN] lynx-ai-assistant Device_ tools 调用失败 & 断点 unbound

## 现象
- 调用 Device.listDevices 时抛错：`i.sent(...).listDevices is not a function`（从主进程堆栈看到，发生在 invokePluginEvent 返回的结果链路中）
- 有时触发 `invokePluginEvent timeout`
- 渲染端源码断点在 `plugins/lynx-ai-assistant/renderer/index.tsx` 显示 unbound

## 期望
- Device_ 工具可以正常执行（至少 listDevices/listClients/listSessions 能返回结构化数据）
- invokePluginEvent 不应超时；若渲染端出错，主进程应收到 error 而非 timeout
- 断点能绑定到实际运行的源码位置

## 假设（可证伪）
1. `debugDriver.getRemoteDebugDriver()` 返回对象不包含 `listDevices/listClients/sendListSessionMessage`，因此调用报 “not a function”。
2. 渲染端未创建/未初始化 AI Assistant 插件视图时，没有注册 `EXECUTE_CDP_COMMAND` 的 listener，导致主进程等待到 timeout。
3. 渲染端 listener 实际抛错，但错误没有通过 `PLUGIN_EVENT_CUSTOM_EVENT_RESPONSE` 回传主进程，表现为 timeout 或堆栈不一致。
4. Electron DevTools 连接的是错误的进程/没有正确加载 sourcemap，导致断点 unbound（即使代码在运行）。
5. 运行时加载的并非本地源码对应的 bundle（缓存/旧产物），导致断点和实际执行代码不一致。

## 证据收集计划
- 启动 debug server 收集主/渲染端结构化日志
- 在渲染端 `EXECUTE_CDP_COMMAND` listener 内上报：
  - `type/method/params`（去敏）
  - `driver`、`remoteDriver` 的可用方法列表（Object.keys/原型链方法名）
  - 调用路径命中情况与异常 message/stack（如果可拿到）
- 在主进程 invokePluginEvent 侧上报：
  - event.id、eventName、pluginId、timeout
  - 是否收到 response（data/error）

## 当前状态
- [ ] 已启动 debug server
- [ ] 已插入 instrumentation（仅日志上报，不改业务逻辑）
- [ ] 复现并采集 pre-fix 日志
- [ ] 基于证据实现最小修复
- [ ] 采集 post-fix 日志并对比
