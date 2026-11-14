import { newId } from './id.js';
import { io } from 'socket.io-client';
export const MAX_FILE = 100 * 1024 * 1024;
export function connect(events, serverUrl, options = {}) {
  const socket = io(serverUrl, { autoConnect: false, transports: ['websocket'], path: options.path || (!serverUrl && import.meta.env?.PROD ? '/api/relay' : '/socket.io') });
  let ready = false, room, disposed = false, recipient;
  const pending = new Map(), incoming = new Map(), urls = new Set();
  const emit = (event, data) => new Promise((resolve, reject) => socket.timeout(20000).emit(event, data, (error, result) => error || result?.error ? reject(new Error(result?.error || 'Connection interrupted. Please try again.')) : resolve(result)));
  async function request(event, data) {
    const deadline = Date.now() + 20000;
    while (!ready && !disposed && Date.now() < deadline) await new Promise(r => setTimeout(r, 40));
    if (!ready || disposed) throw new Error('Connection unavailable.');
    return emit(event, data);
  }
  function cleanup() {
    room = null; recipient = null;
    for (const entry of pending.values()) entry.reject(new Error('Room closed.'));
    pending.clear(); incoming.clear();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  }
  function members(list) {
    if (room) room.members = list;
    events.members?.(list);
    events.paired(list.length > 1);
    events.mode('Server relay');
  }
  function destination() {
    if (!room) throw new Error('Join a room first.');
    const target = room.host ? room.members?.find(m => !m.host && m.id === recipient) : room.members?.find(m => m.host);
    if (!target) throw new Error('Choose a connected guest first.');
    return target.id;
  }
  async function deliver(payload, to) {
    const id = newId(); let timer;
    const receipt = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, from: to });
      timer = setTimeout(() => reject(new Error('Delivery confirmation unavailable. Please check the receiving device.')), 20000);
    });
    receipt.catch(() => {});
    try { await request('signal', { to, deliveryId: id, payload }); await receipt; }
    finally { clearTimeout(timer); pending.delete(id); }
  }
  async function receive(packet, from, sender) {
    const key = from + ':' + packet.id;
    if (packet.type === 'chat') {
      if (typeof packet.text !== 'string' || packet.text.length > 4000) throw new Error('Invalid note.');
      events.message({ id: newId(), text: packet.text, sender, mine: false }); return;
    }
    if (packet.type === 'start') {
      if (incoming.has(key) || incoming.size >= 4 || !Number.isSafeInteger(packet.size) || packet.size < 0 || packet.size > MAX_FILE || typeof packet.name !== 'string' || packet.name.length > 255) throw new Error('Cannot accept this file.');
      incoming.set(key, { ...packet, chunks: [], bytes: 0 });
      events.file({ id: key, name: packet.name, size: packet.size, sender, progress: 0, mine: false }); return;
    }
    const file = incoming.get(key);
    if (!file) throw new Error('Transfer no longer available. Please resend.');
    if (packet.type === 'cancel') { incoming.delete(key); events.file({ id: key, error: 'Transfer interrupted.' }); return; }
    if (packet.type === 'chunk') {
      if (typeof packet.data !== 'string' || packet.data.length > 44000) throw new Error('Invalid chunk.');
      const data = Uint8Array.from(atob(packet.data), c => c.charCodeAt(0));
      if (data.length > 32768 || file.bytes + data.length > file.size) throw new Error('Invalid chunk size.');
      file.chunks.push(data); file.bytes += data.length;
      events.file({ id: key, progress: file.size ? Math.min(99, Math.round(file.bytes / file.size * 100)) : 0 }); return;
    }
    if (packet.type === 'finish') {
      if (file.bytes !== file.size) throw new Error('Incomplete file.');
      const url = URL.createObjectURL(new Blob(file.chunks, { type: 'application/octet-stream' }));
      urls.add(url); incoming.delete(key); events.file({ id: key, url, progress: 100, done: true }); return;
    }
    throw new Error('Invalid transfer packet.');
  }
  socket.on('signal', async data => {
    if (data.deliveryReceipt) {
      const entry = pending.get(data.deliveryReceipt);
      if (entry?.from !== data.from) return;
      if (data.error) entry.reject(new Error(data.error)); else entry.resolve();
      return;
    }
    if (!data.deliveryId || !data.payload) return;
    let error;
    try { await receive(data.payload, data.from, data.senderName); } catch (e) { error = e.message; }
    request('signal', { to: data.from, deliveryReceipt: data.deliveryId, error }).catch(() => {});
  });
  socket.on('members', members);
  socket.on('ended', reason => { socket.emit('release'); cleanup(); events.ended(reason); });
  socket.on('disconnect', () => { ready = false; events.online(false); });
  socket.on('connect', async () => {
    try {
      if (room?.token) { room = await emit('resume', { code: room.code, token: room.token }); members(room.members); }
      ready = true; events.online(true);
    } catch (error) { cleanup(); ready = true; events.online(true); events.ended(error.message); }
  });
  socket.on('rotate', () => { socket.disconnect(); socket.connect(); });
  socket.on('connect_error', () => events.online(false));
  socket.connect();
  return {
    async feedback(message) { return request('feedback', message); },
    async enter(code, name = '') { room = await request(code ? 'join' : 'create', code ? { code, name } : null); members(room.members || []); return room; },
    selectRecipient(id) { recipient = id; },
    async kick(id) { await request('kick', id); },
    async end() { await request('leave', null); cleanup(); },
    async chat(text) { await deliver({ type: 'chat', text }, destination()); },
    async sendFile(file) {
      if (file.size > MAX_FILE) throw new Error('Files can be up to 100 MB.');
      const to = destination(), id = newId();
      events.file({ id, name: file.name, size: file.size, mine: true, progress: 0 });
      try {
        await deliver({ type: 'start', id, name: file.name, size: file.size }, to);
        for (let offset = 0; offset < file.size; offset += 32768) {
          const bytes = new Uint8Array(await file.slice(offset, offset + 32768).arrayBuffer());
          await deliver({ type: 'chunk', id, data: btoa(String.fromCharCode(...bytes)) }, to);
          events.file({ id, progress: Math.min(99, Math.round((offset + bytes.length) / file.size * 100)) });
        }
        await deliver({ type: 'finish', id }, to); events.file({ id, progress: 100, done: true });
      } catch (error) {
        events.file({ id, error: error.message });
        deliver({ type: 'cancel', id }, to).catch(() => {}); throw error;
      }
    },
    destroy() { disposed = true; cleanup(); socket.disconnect(); }
  };
}
