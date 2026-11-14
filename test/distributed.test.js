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
test('Redis admission is atomic and removed tokens cannot resume', {skip: !url}, async t => {
 const relay=await createDistributedRelay({url,prefix:`test:${randomBytes(8).toString('hex')}:`,ttl:500});
 t.after(()=>relay.shutdown());
 const r=relay.rooms;const host=await r.create('host');
 const results=await Promise.allSettled(Array.from({length:6},(_,i)=>r.join(host.code,`guest${i}`,i===0?'John':'')));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,4);
 const guests=results.filter(x=>x.status==='fulfilled').map(x=>x.value);
 await assert.rejects(r.act('kick',host.code,guests[0].token,'guest0','','host'),/host/);
 await r.act('kick',host.code,host.token,'host','','guest0');
 await assert.rejects(r.act('resume',host.code,guests[0].token,'new'),/credential/);
 const resumed=await r.act('resume',host.code,host.token,'new-host');assert.equal(resumed.host,true);
 await assert.rejects(r.act('leave',host.code,host.token,'host'),/replaced/);
 await new Promise(r=>setTimeout(r,550));await assert.rejects(r.act('read',host.code,host.token,'new-host'),/expired/);
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
  await two.c.chat('Still connected'); assert.equal(one.messages[0].text, 'Still connected');
  const bytes = Uint8Array.from({ length: 100000 }, (_, i) => i % 256);
  await two.c.sendFile(new File([bytes], 'test.bin'));
  const file = [...one.files.values()][0]; assert.equal(file.done, true);
  assert.deepEqual(new Uint8Array(await (await fetch(file.url)).arrayBuffer()), bytes);
  assert.deepEqual(one.ends, []); assert.deepEqual(two.ends, []);
});
