import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createTermsRepository, TermsError } from '../src/terms.mjs';

// Isolated in-memory fixture. Run with `node validation/browser-colors.mjs`.
// Importing this module neither builds the frontend nor starts a server.
const sessionId = 'demo';
const commandPath = '/fixture/terms';
const seedTerms = [
  { name: '灯塔', note: '本项目的登录服务', color: '#b83f36' },
  {
    name: 'GlitchTransitionRendererFeature',
    note: '故障转场渲染扩展',
    color: '#2868b4',
  },
];
const css = `
:root { --dsw-alias-label-primary:#202a35; --dsw-alias-label-secondary:#596575; --dsw-alias-label-tertiary:#768191; --dsw-alias-border-l1:#d2d8e1; --dsw-alias-border-l2:#dce1e8; --dsw-alias-interactive-bg-hover:#e8edf3; --dsw-alias-state-business-primary:#2868b4; --dsw-alias-state-error-primary:#b83f36; --dsw-alias-background-body:#ffffff; --dsw-alias-background-container:#ffffff; --dsw-alias-background-primary:#fff; --dsw-alias-surface-l1:#fff; --dsw-alias-surface-l2:#fff; }
body {font:15px/1.65 system-ui,sans-serif;background:#eef2f6;color:var(--dsw-alias-label-primary);margin:0;}
body[data-theme=dark] {color-scheme:dark;background:#171d26; --dsw-alias-label-primary:#e5eaf0; --dsw-alias-label-secondary:#b1bdcb; --dsw-alias-label-tertiary:#8a97a8; --dsw-alias-border-l1:#485566; --dsw-alias-border-l2:#364253; --dsw-alias-interactive-bg-hover:#2a3544; --dsw-alias-background-body:#222b38; --dsw-alias-background-container:#222b38; --dsw-alias-background-primary:#222b38; --dsw-alias-surface-l1:#222b38; --dsw-alias-surface-l2:#222b38; }
main {max-width:820px;margin:32px auto;padding:0 24px} header{display:flex;justify-content:space-between;align-items:center}h1{font-size:22px}article{margin:20px 0;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px}p{margin:8px 0}.fixture-note{color:var(--dsw-alias-label-secondary)}textarea[aria-label]{box-sizing:border-box;width:100%;min-height:60px;padding:10px;border-radius:8px;margin-top:12px}pre{font-size:12px;white-space:pre-wrap}button{cursor:pointer}button#append{margin-top:14px}
`;

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readCommand(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new TermsError('invalid-request');
    chunks.push(chunk);
  }
  let command;
  try {
    command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new TermsError('invalid-request');
  }
  if (
    !command ||
    typeof command !== 'object' ||
    Array.isArray(command) ||
    typeof command.action !== 'string' ||
    (command.payload !== undefined &&
      (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)))
  )
    throw new TermsError('invalid-request');
  return command;
}

export async function startColorFixture({ port = 0 } = {}) {
  const records = new Map();
  const repository = createTermsRepository({
    get: (key) => records.get(key),
    async put(key, value) {
      records.set(key, structuredClone(value));
    },
  });
  for (const term of seedTerms) await repository.call(sessionId, 'create', term);
  let script;
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.headers.host !== new URL(origin).host) {
      json(response, 403, { ok: false, code: 'invalid-host' });
      return;
    }
    try {
      if (request.url === commandPath) {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          json(response, 405, { ok: false, code: 'method-not-allowed' });
          return;
        }
        if (request.headers.origin && request.headers.origin !== origin) {
          json(response, 403, { ok: false, code: 'invalid-origin' });
          return;
        }
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          json(response, 415, { ok: false, code: 'invalid-content-type' });
          return;
        }
        const command = await readCommand(request);
        if (command.sessionId !== sessionId) throw new TermsError('invalid-session');
        json(response, 200, await repository.call(sessionId, command.action, command.payload));
      } else if (request.method === 'GET' && request.url === '/fixture.js') {
        script ??= build({
          entryPoints: [fileURLToPath(new URL('./browser-colors-entry.mjs', import.meta.url))],
          bundle: true,
          format: 'iife',
          platform: 'browser',
          loader: { '.css': 'text' },
          write: false,
        }).then((result) => result.outputFiles[0].text);
        const contents = await script;
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(contents);
      } else if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(
          `<!doctype html><meta charset="utf-8"><title>Session term color fixture</title><style>${css}</style><div id="app"></div><script src="/fixture.js"></script>`,
        );
      } else {
        json(response, 404, { ok: false, code: 'not-found' });
      }
    } catch (error) {
      json(response, error instanceof TermsError ? 200 : 500, {
        ok: false,
        code: error instanceof TermsError ? error.code : 'internal-error',
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url,
    endpoint: new URL(commandPath, url).href,
    sessionId,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await startColorFixture();
  console.log(`Color fixture URL: ${fixture.url}`);
}
