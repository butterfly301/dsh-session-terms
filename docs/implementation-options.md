# 会话术语库实现说明

## 宿主接入

插件以独立 bundle 安装，面向 DSH `0.2.2-rc.1`。

输入区使用 `conversation.input.dock` 槽位，`order` 为 30。术语栏占据输入卡片前的一行布局空间。其他插件替换默认输入区时，可能影响该槽位显示。

文字选择入口使用 `conversation.chat.text-interaction` 的 `quote` key，以 `priority: -100` 注册引用和收录按钮。引用调用宿主 `inputActions.insertQuote`；收录请求保存在会话状态中，由术语栏挂载编辑窗口。注销时恢复宿主引用入口。

客户端通过 `remote.commands.execute` 调用 `session-terms` 命令。命令记录由显示过滤器隐藏，过滤器跟踪宿主定义的注册、移除和重新挂载。Host 向 AI 注册 `session_terms_lookup` 只读查询工具。

## 模块

| 模块                                               | 职责                                         |
| -------------------------------------------------- | -------------------------------------------- |
| [index.js](../index.js)                            | 存储域、命令与查询工具注册                   |
| [terms.mjs](../src/terms.mjs)                      | 词条数据、会话仓库、匹配和写入校验           |
| [context.mjs](../src/context.mjs)                  | 模型请求中的术语匹配与上下文去重             |
| [i18n.mjs](../src/i18n.mjs)                        | Host 语言资源读取与回退                      |
| [src/client.js](../src/client.js)                  | 浏览器模块入口                               |
| [plugin.mjs](../src/client/plugin.mjs)             | 客户端装配、React 订阅、样式与监听器生命周期 |
| [host.mjs](../src/client/host.mjs)                 | 命令通信与记录显示过滤                       |
| [state.mjs](../src/client/state.mjs)               | 会话缓存、请求互斥、刷新、撤销和闲置释放     |
| [editor.mjs](../src/client/editor.mjs)             | 编辑草稿、版本基线和冲突恢复                 |
| [manager.mjs](../src/client/manager.mjs)           | 搜索、排序、多选和删除确认                   |
| [dock.mjs](../src/client/dock.mjs)                 | 术语栏、备注浮层和选择入口                   |
| [common.mjs](../src/client/common.mjs)             | 按钮、图标、弹窗和状态提示                   |
| [interactions.mjs](../src/client/interactions.mjs) | 文字收录、引用、拖动和滚轮规则               |
| [styles.css](../src/client/styles.css)             | 插件样式和响应式布局                         |

## 数据与并发

Host 按 `sessionId` 保存数据，同一会话的写入串行执行。`expectedRevision` 校验术语库修订号；编辑携带的 `expectedVersion` 固定为打开词条时的版本。冲突时刷新数据，保留未保存草稿，由用户载入最新内容后继续编辑。原词条已删除时，草稿可转为新增。

客户端在订阅会话、窗口回到前台和打开管理面板时刷新。写入期间的刷新请求合并排队，待写入结束后执行。无订阅者的缓存闲置一分钟后释放，正在进行的请求完成后再释放。

单条删除使用乐观更新，并保留八秒撤销状态。批量删除使用一次 Host 写入。确认窗口保存所选 ID，显示数量和提交目标均与最新词条列表取交集。

## 上下文去重

`pre-step` 为本次用户正文匹配术语，缺失内容随接受的消息批次进入日志。在带本步 `signal` 且无 `toolSet` 的动态背景刷新中，适配器检查 `deriveMessages`；发现完整备注已被压缩移除时，追加术语消息。

去重依据相同 ID 最近一次完整名称与备注，检查插件消息及有效查询结果。提供给模型的词条结构为 `{ id, name, note }`。

适配依赖 DSH `0.2.2-rc.1` 的请求准备顺序。升级宿主时，重点验证压缩后内容恢复、工具结果剪枝、取消、失败重试和日志重建。其他插件若在背景回调中修改上下文，也需要验证交互行为。

## 语言资源与构建

语言资源位于 `locale`，每个 BCP 47 语言标识对应一份 JSON，包含 `meta`、`ui`、`errors` 和 `host`。新增语言时复制已有资源并翻译全部字段，目标语言需由 DSH 的客户端语言设置支持。

界面跟随 DSH 客户端语言。`locale/config.json` 的 `defaultLocale` 指定 Host 默认语言，资源按 BCP 47 层级回退。

执行构建：

```bash
npm run build
```

[构建脚本](../scripts/build.mjs)发现语言资源，校验翻译键与占位符，再由 esbuild 将客户端 ESM、语言数据和 CSS 打包为根目录的 [client.js](../client.js)。修改界面时编辑源码，运行时 React 由宿主提供。

npm 的 `prepack` 自动执行构建。发布文件由 [package.json](../package.json) 的 `files` 白名单控制，包含运行入口、Host 模块、语言资源、图标、说明和许可证。

## 测试

在源码仓库中执行：

```bash
npm ci --legacy-peer-deps
npm test
npm run format:check
```

普通测试覆盖词条逻辑、会话状态、缓存、并发、语言资源和 Host 协议。编辑器、管理窗口与选择入口通过 React 和 jsdom 挂载验证。jsdom 中的 popover 方法由测试模拟，遮罩、布局、滚轮手势和焦点需在浏览器中验证。

宿主集成测试使用 Electron 的 Node 模式运行 [run-context-gate.cjs](../validation/run-context-gate.cjs) 和 [run-host.cjs](../validation/run-host.cjs)。脚本通过 `DSH_VERIFY_MODULES` 接收 DSH 安装内的 `@deepseek-ai` 模块目录，默认路径见脚本开头。

[命令显示探针](../validation/command-visibility.cjs)、[选择槽位探针](../validation/selection-slot-feasibility.cjs)和[客户端注入探针](../validation/client-injection.cjs)检查宿主扩展接口。部分探针读取宿主构建中的内部实现，升级 DSH 时需要复核。

## 宿主接口边界

展开栏以浏览器视口高度的 20% 与 160 像素的较小值为上限。文字选择接口缺少代码块身份，收录入口依靠所选文本。会话永久删除后的术语持久化数据清理由用户操作。
