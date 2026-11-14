import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../server.js';
import { connect, MAX_FILE } from '../src/connection.js';

test('browser transport fallback transfers chunked bytes, empty files and chat both ways', { timeout: 15000 }, async t => {
  const relay = createRelay();
  await new Promise(r => relay.http.listen(0, '127.0.0.1', r));
  const clients = [];
  t.after(async () => { clients.forEach(c => c.destroy()); await new Promise(r => relay.io.close(r)); });
  const url = `http://127.0.0.1:${relay.http.address().port}`;
  function device() {
    const files = new Map(), messages = [];
    const c = connect({ online() {}, paired() {}, mode() {}, error(e) { throw new Error(e); }, ended() {}, message(m) { messages.push(m); }, file(f) { files.set(f.id, { ...files.get(f.id), ...f }); } }, url);
    clients.push(c); return { c, files, messages };
  }
  const a = device(), b = device(); const room = await a.c.enter(); const guest = await b.c.enter(room.code); a.c.selectRecipient(guest.memberId); await new Promise(r => setTimeout(r,30));
  const data = Uint8Array.from({ length: 100000 }, (_, i) => i % 256);
  await a.c.sendFile(new File([data], 'binary.dat'));
  const received = [...b.files.values()][0]; assert.equal(received.done, true);
  assert.deepEqual(new Uint8Array(await (await fetch(received.url)).arrayBuffer()), data);
  await b.c.sendFile(new File([], 'empty.txt'));
  const empty = [...a.files.values()].find(f => f.name === 'empty.txt'); assert.equal(empty.done, true);
  assert.equal((await (await fetch(empty.url)).arrayBuffer()).byteLength, 0);
  await a.c.chat('message one'); await b.c.chat('message two');
  assert.equal(b.messages[0].text, 'message one'); assert.equal(a.messages[0].text, 'message two');
  await assert.rejects(a.c.sendFile({ size: MAX_FILE + 1 }), /100 MB/);
});
