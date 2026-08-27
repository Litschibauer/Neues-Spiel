import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const CHROME = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p))!;

const PORT = 8792;
const OUT = process.argv[2] ?? 'hof.png';
const W = Number(process.argv[3] ?? 900);
const H = Number(process.argv[4] ?? 1000);

const server = spawn(
  'node',
  ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', 'src/server/http.ts', '--env=dev'],
  { env: { ...process.env, PORT: String(PORT), NEUES_SPIEL_HOST: '127.0.0.1' }, stdio: 'ignore' },
);
const browser = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9335', `--window-size=${W},${H}`, 'about:blank',
]);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await wait(250); }
  let ws: WebSocket | null = null;
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      const list = (await (await fetch('http://127.0.0.1:9335/json')).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws!.onopen = () => r(null))); }
    } catch {}
    if (!ws) await wait(250);
  }
  let id = 1; const pend = new Map<number, (v: any) => void>();
  ws!.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result); pend.delete(m.id); } };
  const send = (method: string, params: unknown = {}) => new Promise<any>((res) => { const n = id++; pend.set(n, res); ws!.send(JSON.stringify({ id: n, method, params })); });
  const js = (expr: string) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value);

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await wait(2500);
  await js(`document.getElementById('create') && document.getElementById('create').click()`);
  await wait(1200);
  await js(`document.getElementById('keydone') && document.getElementById('keydone').click()`);
  await wait(2500);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('gespeichert:', OUT);
  ws!.close(); browser.kill(); server.kill(); process.exit(0);
}
main().catch((e) => { console.error(e); browser.kill(); server.kill(); process.exit(1); });
