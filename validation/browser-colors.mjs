import { createServer } from 'node:http';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Isolated browser fixture using the actual editor, dock, store and highlighter.
// Run with `node validation/browser-colors.mjs`; stop the process after inspection.
const result = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createTermsStore } from './src/client/state.mjs';
import { createUiPrimitives } from './src/client/common.mjs';
import { createTermEditor } from './src/client/editor.mjs';
import { createManager } from './src/client/manager.mjs';
import { createDock } from './src/client/dock.mjs';
import locale from './locale/zh.json';
import styles from './src/client/styles.css';
const h = React.createElement;
const dictionaries = { ...locale.ui, ...Object.fromEntries(Object.entries(locale.errors).map(([k,v])=>['errors.'+k,v])) };
const t = key => dictionaries[key] ?? key;
let state = { revision: 0, expanded: false, terms: [
  { id: 'one', name: '灯塔', note: '本项目的登录服务', color: '#b83f36', version: 1, order: 0 },
  { id: 'two', name: 'GlitchTransitionRendererFeature', note: '故障转场渲染扩展', color: '#2868b4', version: 1, order: 1 },
] };
const store = createTermsStore('demo', async (_id, action, payload) => {
  if (action === 'get') return { ok: true, state: structuredClone(state) };
  const terms = state.terms.map(term => ({...term}));
  if (action === 'update') {
    const term = terms.find(term=>term.id===payload.id);
    Object.assign(term, { name: payload.name, note: payload.note, color: payload.color, version: term.version+1 });
  } else if (action === 'create') terms.push({ ...payload, id: crypto.randomUUID(), version: 1, order: terms.length });
  else if (action === 'delete') terms.splice(terms.findIndex(term=>term.id===payload.id),1);
  state = { ...state, revision: state.revision+1, terms, ...(action==='setExpanded'?{expanded:payload.expanded}:{}) };
  return { ok: true, state: structuredClone(state) };
});
function useTerms() { return [React.useSyncExternalStore(store.subscribe, store.getSnapshot), store]; }
const ui = createUiPrimitives(React, Object.keys(locale.errors));
const Editor = createTermEditor({React, useTerms, ui});
const Manager = createManager({React, useTerms, ui, TermEditor: Editor});
const {StartedTermsDock: Dock} = createDock({React, useTerms, ui, TermEditor: Editor, Manager, focusInput() {}});
function App() {
  const [dark,setDark] = React.useState(false);
  React.useEffect(()=> { document.body.dataset.theme=dark?'dark':'light'; },[dark]);
  return h('main', null,
    h('header',null,h('h1',null,'术语颜色 · 浏览器验证'),h('button',{onClick:()=>setDark(v=>!v)},'切换主题')),
    h('p', {className:'fixture-note'},'独立测试页面，使用插件实际编辑器、术语栏和着色模块。'),
    h('section',{'data-conversation-region':'chat','data-conversation-session':'demo'},
      h('article',{'data-chat-flow-kind':'user'},h('div',{'data-message-bubble':'','data-text-interaction-source':''},h('span',{className:'_plainRun_fbulu_6'},'请检查灯塔，以及 GlitchTransitionRendererFeature 的配置。'))),
      h('article',{'data-chat-flow-kind':'assistant-step'},h('div',{className:'xMeOpW_body','data-streaming':'true'},
        h('div',{className:'_markdown_rve47_5'},
          h('p',null,'灯塔是本项目的登录服务。GlitchTransitionRendererFeature 负责故障转场。'),
          h('p',{id:'stream'},'流式片段：'),
          h('pre',null,'代码块保持原样：灯塔 GlitchTransitionRendererFeature')),
        h('div',{'data-variant':'think'},'思考过程保持原样：灯塔'))),
      h('article',{'data-chat-flow-kind':'tool-call'},h('p',null,'工具输出保持原样：灯塔')),
      h('div',{'data-conversation-region':'composer','data-composer-seat':''},
        h(Dock,{sessionId:'demo',t,useSession:select=>select({running:true})}),
        h('textarea',{'aria-label':'消息草稿',placeholder:'消息草稿中的灯塔保持原样'}))),
    h('button',{id:'append',onClick:()=> {document.getElementById('stream').append('灯塔 ');}},'追加流式文本'));
}
const style=document.createElement('style'); style.textContent=styles;document.head.append(style);
createRoot(document.getElementById('app')).render(h(App));
window.colorFixture={store};
`,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.css': 'text' },
  write: false,
});
const css = `
:root { --dsw-alias-label-primary:#202a35; --dsw-alias-label-secondary:#596575; --dsw-alias-label-tertiary:#768191; --dsw-alias-border-l1:#d2d8e1; --dsw-alias-border-l2:#dce1e8; --dsw-alias-interactive-bg-hover:#e8edf3; --dsw-alias-state-business-primary:#2868b4; --dsw-alias-state-error-primary:#b83f36; --dsw-alias-background-body:#ffffff; --dsw-alias-background-container:#ffffff; --dsw-alias-background-primary:#fff; --dsw-alias-surface-l1:#fff; --dsw-alias-surface-l2:#fff; }
body {font:15px/1.65 system-ui,sans-serif;background:#eef2f6;color:var(--dsw-alias-label-primary);margin:0;}
body[data-theme=dark] {color-scheme:dark;background:#171d26; --dsw-alias-label-primary:#e5eaf0; --dsw-alias-label-secondary:#b1bdcb; --dsw-alias-label-tertiary:#8a97a8; --dsw-alias-border-l1:#485566; --dsw-alias-border-l2:#364253; --dsw-alias-interactive-bg-hover:#2a3544; --dsw-alias-background-body:#222b38; --dsw-alias-background-container:#222b38; --dsw-alias-background-primary:#222b38; --dsw-alias-surface-l1:#222b38; --dsw-alias-surface-l2:#222b38; }
main {max-width:820px;margin:32px auto;padding:0 24px} header{display:flex;justify-content:space-between;align-items:center}h1{font-size:22px}article{margin:20px 0;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px}p{margin:8px 0}.fixture-note{color:var(--dsw-alias-label-secondary)}textarea[aria-label]{box-sizing:border-box;width:100%;min-height:60px;padding:10px;border-radius:8px;margin-top:12px}pre{font-size:12px;white-space:pre-wrap}button{cursor:pointer}button#append{margin-top:14px}
`;
const script = result.outputFiles[0].text;
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(script);
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Session term color fixture</title><style>${css}</style><div id="app"></div><script src="/fixture.js"></script>`,
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(0, '127.0.0.1', () => {
  console.log(`Color fixture URL: http://127.0.0.1:${server.address().port}/`);
});
