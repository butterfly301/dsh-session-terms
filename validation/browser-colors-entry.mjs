import React from 'react';
import { createRoot } from 'react-dom/client';
import { createTermsStore } from '../src/client/state.mjs';
import { createUiPrimitives } from '../src/client/common.mjs';
import { createTermEditor } from '../src/client/editor.mjs';
import { createManager } from '../src/client/manager.mjs';
import { createDock } from '../src/client/dock.mjs';
import locale from '../locale/zh.json';
import styles from '../src/client/styles.css';

const h = React.createElement;
const sessionId = 'demo';
const dictionaries = {
  ...locale.ui,
  ...Object.fromEntries(
    Object.entries(locale.errors).map(([key, value]) => ['errors.' + key, value]),
  ),
};
const t = (key) => dictionaries[key] ?? key;
const store = createTermsStore(sessionId, async (sessionId, action, payload) => {
  const response = await fetch('/fixture/terms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, action, payload }),
  });
  return response.json();
});
function useTerms() {
  return [React.useSyncExternalStore(store.subscribe, store.getSnapshot), store];
}
const ui = createUiPrimitives(React, Object.keys(locale.errors));
const Editor = createTermEditor({ React, useTerms, ui });
const Manager = createManager({ React, useTerms, ui, TermEditor: Editor });
const { StartedTermsDock: Dock } = createDock({
  React,
  useTerms,
  ui,
  TermEditor: Editor,
  Manager,
  focusInput() {},
});
function App() {
  const [dark, setDark] = React.useState(false);
  React.useEffect(() => {
    document.body.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return h(
    'main',
    null,
    h(
      'header',
      null,
      h('h1', null, '术语颜色 · 浏览器验证'),
      h('button', { onClick: () => setDark((value) => !value) }, '切换主题'),
    ),
    h('p', { className: 'fixture-note' }, '独立测试页面，使用插件实际编辑器、术语栏和着色模块。'),
    h(
      'section',
      { 'data-conversation-region': 'chat', 'data-conversation-session': sessionId },
      h(
        'article',
        { 'data-chat-flow-kind': 'user' },
        h(
          'div',
          { 'data-message-bubble': '', 'data-text-interaction-source': '' },
          h(
            'span',
            { className: '_plainRun_fbulu_6' },
            '请检查灯塔，以及 GlitchTransitionRendererFeature 的配置。',
          ),
        ),
      ),
      h(
        'article',
        { 'data-chat-flow-kind': 'assistant-step' },
        h(
          'div',
          { className: 'xMeOpW_body', 'data-streaming': 'true' },
          h(
            'div',
            { className: '_markdown_rve47_5' },
            h('p', null, '灯塔是本项目的登录服务。GlitchTransitionRendererFeature 负责故障转场。'),
            h('p', { id: 'stream' }, '流式片段：'),
            h('pre', null, '代码块保持原样：灯塔 GlitchTransitionRendererFeature'),
          ),
          h('div', { 'data-variant': 'think' }, '思考过程保持原样：灯塔'),
        ),
      ),
      h('article', { 'data-chat-flow-kind': 'tool-call' }, h('p', null, '工具输出保持原样：灯塔')),
      h(
        'div',
        { 'data-conversation-region': 'composer', 'data-composer-seat': '' },
        h(Dock, { sessionId, t, useSession: (select) => select({ running: true }) }),
        h('textarea', { 'aria-label': '消息草稿', placeholder: '消息草稿中的灯塔保持原样' }),
      ),
    ),
    h(
      'button',
      {
        id: 'append',
        onClick: () => {
          document.getElementById('stream').append('灯塔 ');
        },
      },
      '追加流式文本',
    ),
  );
}
const style = document.createElement('style');
style.textContent = styles;
document.head.append(style);
createRoot(document.getElementById('app')).render(h(App));
window.colorFixture = { store };
