import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as client } from 'socket.io-client';
import { createRelay } from '../server.js';

async function fixture(t, ttl) {
  const relay = createRelay({ ttl });
  await new Promise(r => relay.http.listen(0, '127.0.0.1', r));
  const sockets = [];
  t.after(async () => { for (const s of sockets) s.disconnect(); await new Promise(r => relay.io.close(r)); });
  async function device() {
    const s = client(`http://127.0.0.1:${relay.http.address().port}`, { transports: ['websocket'], forceNew: true });
    sockets.push(s); await new Promise(r => s.once('connect', r)); return s;
  }
  return { ...relay, device };
}
const call = (s, event, data) => new Promise((resolve, reject) => s.timeout(2000).emit(event, data, (err, result) => err ? reject(err) : resolve(result)));
const once = (s, event) => new Promise(r => s.once(event, r));

test('rooms pair two devices, reject outsiders, relay exact bytes and close together', async t => {
  const f = await fixture(t); const a = await f.device(), b = await f.device(), outsider = await f.device();
  const room = await call(a, 'create', null); assert.match(room.code, /^[A-Z2-9]{4}$/);
  assert.equal((await call(b, 'join', room.code.toLowerCase())).host, false);
  assert.match((await call(outsider, 'join', room.code)).error, /two devices/);
  assert.match((await call(outsider, 'packet', { type: 'chat', text: 'bad' })).error, /not connected/);
  const packets = []; b.on('packet', (packet, ack) => { packets.push(packet); ack({ ok: true }); });
  assert.equal((await call(a, 'packet', { type: 'chat', text: 'hello' })).ok, true);
  const binary = Buffer.from([0, 1, 127, 128, 255]);
  assert.equal((await call(a, 'packet', { type: 'chunk', id: 'one', data: binary })).ok, true);
  assert.equal(packets[0].text, 'hello'); assert.deepEqual(packets[1].data, binary);
  const ended = once(b, 'ended'); a.emit('end'); assert.match(await ended, /closed/);
  assert.equal(f.rooms.size, 0);
  assert.match((await call(outsider, 'join', room.code)).error, /not found/);
});
test('rooms expire and disconnects remove membership', async t => {
  const f = await fixture(t, 100); const a = await f.device();
  await call(a, 'create', null); assert.match(await once(a, 'ended'), /expired/); assert.equal(f.rooms.size, 0);
  const b = await f.device(); const room = await call(a, 'create', null); await call(b, 'join', room.code);
  const ended = once(b, 'ended'); a.disconnect(); assert.match(await ended, /disconnected/); assert.equal(f.rooms.size, 0);
});
test('invalid codes and repeated join attempts are bounded', async t => {
  const f = await fixture(t); const a = await f.device();
  assert.match((await call(a, 'join', {})).error, /not found/);
  let response; for (let i = 0; i < 30; i++) response = await call(a, 'join', 'INVALID1');
  assert.match(response.error, /Too many/);
});
