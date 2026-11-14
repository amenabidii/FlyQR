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

test('outsiders cannot signal and guests cannot close the room', async t => {
 const f=await fixture(t);const a=await f.device(),b=await f.device(),outsider=await f.device();
 const room=await call(a,'create',null);assert.match(room.code,/^[A-Z2-9]{4}$/);
 await call(b,'join',room.code);
 assert.ok((await call(outsider,'signal',{})).error);
 assert.ok((await call(b,'end',null)).error);
 const ended=once(b,'ended');await call(a,'end',null);assert.match(await ended,/closed/);
});
test('rooms expire and disconnects remove membership', async t => {
  const f = await fixture(t, 100); const a = await f.device();
  await call(a, 'create', null); assert.match(await once(a, 'ended'), /expired/); assert.equal(f.rooms.size, 0);
  const b = await f.device(); const room = await call(a, 'create', null); await call(b, 'join', room.code);
  const ended = once(b, 'ended'); a.disconnect(); assert.match(await ended, /closed/); assert.equal(f.rooms.size, 0);
});
test('invalid codes and repeated join attempts are bounded', async t => {
  const f = await fixture(t); const a = await f.device();
  assert.match((await call(a, 'join', {})).error, /not found/);
  let response; for (let i = 0; i < 30; i++) response = await call(a, 'join', 'INVALID1');
  assert.match(response.error, /Too many/);
});
