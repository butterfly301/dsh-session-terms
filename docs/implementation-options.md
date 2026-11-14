# 会话术语插件实现

## 宿主接入

插件面向 DSH 0.2.2-rc.1，以独立 bundle 安装，不修改宿主。输入区使用正式槽位 conversation.input.dock，order 为 30，术语栏正常占据输入卡片前的一行布局空间。其他插件完整替换默认 composer 时，术语栏也可能被隐藏。

文字选择入口使用 conversation.chat.text-interaction 的 quote key，以 priority -100 提供相邻的引用和收录按钮。引用仍调用宿主 inputActions.insertQuote；收录请求保存在会话状态中，由术语栏拥有编辑窗口，选择浮层消失后编辑窗口继续存在。卸载插件会恢复宿主引用入口。

客户端通过 remote.commands.execute 调用 session-terms 命令，写入不会生成模型消息。Host 只给 AI 注册 session_terms_lookup 只读工具。命令记录的显示过滤复用宿主原定义，并跟踪其延迟注册、移除和重新挂载。

## 客户端模块

[src/client.js](../src/client.js) 只声明宿主模块入口。[plugin.mjs](../src/client/plugin.mjs) 组合状态、界面和宿主适配，并拥有样式、前台监听器和插件注销逻辑。

[host.mjs](../src/client/host.mjs) 封装命令传输与记录显示过滤；[state.mjs](../src/client/state.mjs) 封装请求互斥、缓存刷新、删除撤销和生命周期。React 与测试调用同一个状态接口，测试通过注入 request 和时钟控制失败、并发与缓存到期。

[editor.mjs](../src/client/editor.mjs) 拥有未保存草稿和编辑基线；[manager.mjs](../src/client/manager.mjs) 拥有搜索、多选与删除确认；[dock.mjs](../src/client/dock.mjs) 拥有输入区术语栏和选择入口。通用按钮与弹窗维护在 [common.mjs](../src/client/common.mjs)，交互规则维护在 [interactions.mjs](../src/client/interactions.mjs)，样式维护在 [styles.css](../src/client/styles.css)。

## 数据与并发

Host 数据按 sessionId 保存，写入按会话串行执行。expectedRevision 校验术语库修订号。编辑另携带 expectedVersion，取打开原词条时的版本；读取到较新的库修订号也不能替换这份编辑基线。词条发生变化时保留草稿并停止保存，用户显式载入最新内容后再编辑。原词条已删除时，可以保留草稿转为新增。

客户端第一次订阅和重新订阅会话时刷新。窗口回到前台时刷新活动会话，打开管理面板时也刷新。没有订阅者的缓存闲置一分钟后释放，正在进行的读写完成后再释放。缓存释放不会删除持久化数据。

多选删除使用一次 Host 写入。确认窗口保存已确认的目标集合，显示和提交时只取其中仍存在的词条。发生修订冲突后刷新列表，确认数量随之变化，继续确认只删除剩余目标。所有目标均已不存在时禁用确认，用户可关闭窗口。

## 上下文去重

[context.mjs](../src/context.mjs) 是版本相关的适配模块。pre-step 为本次用户正文匹配术语，缺失内容随接受的消息批次进入日志。随后在带本步 signal 且无 toolSet 的动态背景刷新中检查 deriveMessages；压缩移除备注后追加独立术语消息。

去重比较相同 id 最近一次完整名称与备注。AI 查询工具返回的完整当前词条也可用于比较；摘要、截断结果或用户复制的标识不能证明内容仍然有效。传给模型的 JSON 只含 id、name 和 note，不暴露内部版本号。

动态背景回调缺少正式的最终消息入场契约。当前 signal 和 toolSet 检查依赖已验证的宿主调用顺序，因此安装版本限定为 DSH 0.2.2-rc.1。兼容测试覆盖预览、取消、压缩替换、失败重试、工具结果剪枝和日志重建；替换 surface 的模拟压缩不等同于完整官方压缩流程的端到端验收。

升级宿主时，应重新验证此适配。更合适的上游接口是在压缩和请求准备完成后、每次实际模型请求前，读取最终有效消息并返回需要追加的持久化背景消息。不能退化为每次命中重复注入。

## 构建与验证

[scripts/build.mjs](../scripts/build.mjs) 自动发现语言资源，校验翻译键与占位符，通过 esbuild 把标准 ESM、语言数据和 CSS 打包成一个宿主加载文件。运行时 React 由宿主提供，开发依赖不会打入客户端。源码、样式和测试使用 Prettier 保持格式一致。

普通测试直接导入模块。编辑器、管理窗口与选择入口使用真实 React 和 jsdom 验证；jsdom 只模拟缺失的 popover 浏览器原语。独立宿主兼容探针仍会读取宿主未公开导出的构建实现，但不截取插件源码来运行测试。

实际浏览器中的遮罩、布局、滚轮手势与焦点仍需验收。公开槽位未提供会话区域高度，展开栏当前使用视口高度的 20% 与 160 像素的较小值。文字选择接口未提供代码块身份，不能严格排除代码块快捷收录。永久删除会话后的持久化数据清理尚未接入。
