import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';
import { createDistributedRelay } from '../backend/distributed.js';
import { connect } from '../src/connection.js';
import { normalizeSocketPath } from '../backend/vercel-path.js';

const url = process.env.TEST_REDIS_URL;
const call = (s, event, data) => new Promise((resolve, reject) => s.timeout(3000).emit(event, data, (error, value) => error ? reject(error) : resolve(value)));
const once = (s, event) => new Promise(resolve => s.once(event, resolve));
test('independent servers share rooms, atomic admission, relay, resume credentials and expiry', { skip: !url, timeout: 20000 }, async t => {
  const prefix = `flyqr-test:${randomBytes(8).toString('hex')}:`;
  const a = await createDistributedRelay({ url, prefix, ttl: 3000, path: '/socket.io' });
  const b = await createDistributedRelay({ url, prefix, ttl: 3000, path: '/socket.io' });
  const sockets = [];
  t.after(async () => { sockets.forEach(s => s.disconnect()); await Promise.all([a.shutdown(), b.shutdown()]); });
  for (const s of [a, b]) await new Promise(r => s.http.listen(0, '127.0.0.1', r));
  async function device(server) {
    const s = io(`http://127.0.0.1:${server.http.address().port}`, { transports: ['websocket'], forceNew: true });
    sockets.push(s); await once(s, 'connect'); return s;
  }
  const host = await device(a), guest = await device(b), outsider = await device(b);
  const room = await call(host, 'create', null);
  const joins = await Promise.all([call(guest, 'join', room.code), call(outsider, 'join', room.code)]);
  assert.equal(joins.filter(r => !r.error).length, 1);
  const receiver = joins[0].error ? outsider : guest;
  receiver.on('packet', (p, ack) => ack({ ok: true, bytes: p.data ? Array.from(p.data) : null }));
  const result = await call(host, 'packet', { type: 'chunk', data: Buffer.from([0, 255, 7]) });
  assert.deepEqual(result.bytes, [0, 255, 7]);
  host.disconnect();
  const resumed = await device(b);
  assert.ok((await call(resumed, 'resume', { code: room.code, token: '0'.repeat(64) })).error);
  assert.equal((await call(resumed, 'resume', room)).host, true);
  assert.equal((await call(resumed, 'packet', { type: 'chat', text: 'after reconnect' })).ok, true);
  const ended = once(receiver, 'ended'); await call(resumed, 'end', null); assert.match(await ended, /closed/);
  assert.ok((await call(receiver, 'packet', { type: 'chat', text: 'late' })).error);
  const expired = await call(resumed, 'create', null);
  await new Promise(r => setTimeout(r, 3100));
  const fresh = await device(a); assert.ok((await call(fresh, 'resume', expired)).error);
});

test('client keeps room through rotation and relays complete binary files across servers', { skip: !url, timeout: 20000 }, async t => {
  const prefix = `flyqr-test:${randomBytes(8).toString('hex')}:`;
  const a = await createDistributedRelay({ url, prefix, ttl: 10000, path: '/socket.io', rotateMs: 1500 });
  const b = await createDistributedRelay({ url, prefix, ttl: 10000, path: '/socket.io', rotateMs: 1500 });
  for (const server of [a, b]) {
    server.http.prependListener('request', normalizeSocketPath);
    server.http.prependListener('upgrade', normalizeSocketPath);
  }
  const clients = [];
  t.after(async () => { clients.forEach(c => c.destroy()); await Promise.all([a.shutdown(), b.shutdown()]); });
  for (const s of [a, b]) await new Promise(r => s.http.listen(0, '127.0.0.1', r));
  function device(s, path) {
    const files = new Map(), messages = [], ends = [];
    const c = connect({ online() {}, paired() {}, mode() {}, error() {}, ended: e => ends.push(e), message: m => messages.push(m), file: f => files.set(f.id, { ...files.get(f.id), ...f }) }, `http://127.0.0.1:${s.http.address().port}`, { path });
    clients.push(c); return { c, files, messages, ends };
  }
  const one = device(a, '/api/relay/socket.io'), two = device(b, '/api/relay');
  const room = await one.c.enter(); await two.c.enter(room.code);
  await new Promise(r => setTimeout(r, 2000));
  await one.c.chat('Still connected'); assert.equal(two.messages[0].text, 'Still connected');
  const bytes = Uint8Array.from({ length: 100000 }, (_, i) => i % 256);
  await one.c.sendFile(new File([bytes], 'test.bin'));
  const file = [...two.files.values()][0]; assert.equal(file.done, true);
  assert.deepEqual(new Uint8Array(await (await fetch(file.url)).arrayBuffer()), bytes);
  assert.deepEqual(one.ends, []); assert.deepEqual(two.ends, []);
});
