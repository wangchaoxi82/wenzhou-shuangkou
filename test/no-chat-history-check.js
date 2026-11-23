// 验证聊天不保存：A 发消息后 B 再进房，B 应收不到历史消息；但实时消息仍能收到。
const WebSocket = require('ws');
const base = process.argv[2];
const wsUrl = base.replace(/^http/, 'ws').replace(/\/$/, '');

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const a = await connect();
  let code = null;
  a.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'state' && m.code) code = m.code;
  });
  a.send(JSON.stringify({ t: 'create', name: '甲甲' }));
  await wait(1500);
  if (!code) { console.error('建房失败'); process.exit(1); }
  a.send(JSON.stringify({ t: 'chat', text: '进房前的消息' }));
  await wait(800);

  const b = await connect();
  let gotHistory = false, gotLive = false;
  b.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'chat-history') gotHistory = true;
    if (m.t === 'chat' && m.text === '进房前的消息') gotHistory = true;
    if (m.t === 'chat' && m.text === '实时消息') gotLive = true;
  });
  b.send(JSON.stringify({ t: 'join', name: '乙乙', code }));
  await wait(1500);
  a.send(JSON.stringify({ t: 'chat', text: '实时消息' }));
  await wait(800);

  console.log('后进房收到历史消息：', gotHistory ? '是（有问题）' : '否（符合要求）');
  console.log('实时消息能收到：', gotLive ? '是' : '否（有问题）');
  a.close(); b.close();
  process.exit(gotHistory || !gotLive ? 1 : 0);
})();
