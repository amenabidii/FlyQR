import { newId } from './id.js';
import { io } from 'socket.io-client';
export const MAX_FILE = 100 * 1024 * 1024;
export function connect(events, serverUrl, options = {}) {
  const socket = io(serverUrl, { autoConnect: false, transports: ['websocket'], path: options.path || (!serverUrl && import.meta.env?.PROD ? '/api/relay' : '/socket.io') });
  let ready = false;
  let generation = 0;
  let peer, channel, room, incoming, disposed = false;
  let candidates = [];
  const urls = new Set();
  const receipts = new Map();
  const emit = (event, data) => new Promise((resolve, reject) => socket.timeout(20000).emit(event, data, (err, result) => err || result?.error ? reject(new Error(result?.error || 'Connection interrupted. Please resend.')) : resolve(result)));
  async function request(event, data) {
    const startedIn = generation;
    const deadline = Date.now() + 20000;
    while (!ready) {
      if (disposed || startedIn !== generation || Date.now() > deadline) throw new Error('Connection unavailable. Please try again.');
      await new Promise(r => setTimeout(r, 50));
    }
    if (disposed || startedIn !== generation) throw new Error('Room closed.');
    return emit(event, data);
  }
  function cleanup() {
    generation++;
    peer?.close(); peer = null; channel = null; candidates = []; incoming = null; room = null;
    for (const item of receipts.values()) item.reject(new Error('Room closed.'));
    receipts.clear();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  }
  async function receive(packet) {
    if (!packet || typeof packet !== 'object') throw new Error('Invalid data.');
    if (packet.type === 'chat') {
      if (typeof packet.text !== 'string' || packet.text.length > 4000) throw new Error('Message is too long.');
      events.message({ text: packet.text, mine: false, id: newId() });
    } else if (packet.type === 'start') {
      if (incoming || !Number.isSafeInteger(packet.size) || packet.size < 0 || packet.size > MAX_FILE || typeof packet.name !== 'string' || packet.name.length > 255) throw new Error('Cannot accept this file.');
      incoming = { ...packet, chunks: [], bytes: 0 };
      events.file({ id: packet.id, name: packet.name, size: packet.size, progress: 0, mine: false });
    } else if (packet.type === 'chunk') {
      if (!incoming || incoming.id !== packet.id) throw new Error('Transfer no longer available.');
      const raw = packet.data;
      const data = ArrayBuffer.isView(raw) ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw;
      if (!(data instanceof ArrayBuffer) || data.byteLength > 32768 || incoming.bytes + data.byteLength > incoming.size) throw new Error('Invalid file chunk.');
      incoming.chunks.push(data); incoming.bytes += data.byteLength;
      events.file({ id: incoming.id, progress: incoming.size ? Math.round(incoming.bytes / incoming.size * 100) : 100 });
    } else if (packet.type === 'finish') {
      if (!incoming || incoming.id !== packet.id || incoming.bytes !== incoming.size) throw new Error('Incomplete file. Please resend it.');
      const url = URL.createObjectURL(new Blob(incoming.chunks, { type: 'application/octet-stream' }));
      urls.add(url); events.file({ id: incoming.id, url, progress: 100, done: true }); incoming = null;
      await request('packet', { type: 'received', id: packet.id });
    } else if (packet.type === 'received') {
      receipts.get(packet.id)?.resolve(); receipts.delete(packet.id);
    } else if (packet.type === 'cancel') {
      if (incoming?.id === packet.id) { events.file({ id: incoming.id, error: 'Transfer interrupted. Please resend.' }); incoming = null; }
    }
  }
  function bind(dc) {
    channel = dc; dc.binaryType = 'arraybuffer';
    dc.onopen = () => events.mode('Direct connection');
    dc.onclose = () => events.mode('Server relay');
    dc.onmessage = event => {
      try {
        const packet = typeof event.data === 'string' ? JSON.parse(event.data) : { type: 'chunk', id: incoming?.id, data: event.data };
        receive(packet).catch(error => events.error(error.message));
      } catch { events.error('Invalid transfer data. Please resend.'); }
    };
  }
  function setupPeer() {
    if (peer) return peer;
    peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peer.onicecandidate = e => { if (e.candidate) request('signal', { candidate: e.candidate.toJSON() }).catch(() => {}); };
    peer.ondatachannel = e => bind(e.channel);
    return peer;
  }
  socket.on('signal', async data => {
    try {
      const pc = setupPeer();
      if (data.description) {
        await pc.setRemoteDescription(data.description);
        for (const candidate of candidates) await pc.addIceCandidate(candidate);
        candidates = [];
        if (data.description.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); request('signal', { description: pc.localDescription }).catch(() => {}); }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate); else candidates.push(data.candidate);
      }
    } catch { events.mode('Server relay'); }
  });
  socket.on('paired', async () => {
    events.paired(); events.mode(channel?.readyState === 'open' ? 'Direct connection' : 'Server relay');
    try {
      if (room?.host && !peer) { const pc = setupPeer(); bind(pc.createDataChannel('files')); await pc.setLocalDescription(await pc.createOffer()); request('signal', { description: pc.localDescription }).catch(() => {}); }
    } catch { /* Relay works without WebRTC. */ }
  });
  socket.on('packet', (packet, ack) => { receive(packet).then(() => ack({ ok: true })).catch(e => ack({ error: e.message })); });
  socket.on('ended', reason => { socket.emit('release'); cleanup(); events.ended(reason); });
  socket.on('disconnect', () => {
    ready = false; events.online(false);
    if (room?.token) events.mode('Reconnecting…');
    else if (room) { cleanup(); events.ended('Connection lost. Please create or join a new room.'); }
  });
  socket.on('connect', async () => {
    try {
      if (room?.token) {
        const previous = room;
        const restored = await emit('resume', { code: previous.code, token: previous.token });
        if (room === previous) room = restored;
        else socket.emit('release');
      }
      ready = true; events.online(true);
      if (room) events.mode(channel?.readyState === 'open' ? 'Direct connection' : 'Server relay');
    } catch (error) { cleanup(); ready = true; events.online(true); events.ended(error.message); }
  });
  socket.on('rotate', () => { socket.disconnect(); socket.connect(); });
  socket.on('connect_error', () => events.online(false));
  socket.connect();
  return {
    async enter(code) { room = await request(code ? 'join' : 'create', code || null); return room; },
    async end() { await request('end', null); cleanup(); },
    async chat(text) { await request('packet', { type: 'chat', text }); },
    async sendFile(file) {
      if (file.size > MAX_FILE) throw new Error('Files can be up to 100 MB.');
      const id = newId();
      const direct = channel?.readyState === 'open' ? channel : null;
      const send = async packet => {
        if (!room || disposed) throw new Error('Room closed.');
        if (!direct) return request('packet', packet);
        const deadline = Date.now() + 20000;
        while (direct.bufferedAmount > 262144) { if (Date.now() > deadline || direct.readyState !== 'open') throw new Error('Transfer interrupted. Please resend.'); await new Promise(r => setTimeout(r, 20)); }
        if (direct.readyState !== 'open') throw new Error('Transfer interrupted. Please resend.');
        direct.send(packet.type === 'chunk' ? packet.data : JSON.stringify(packet));
      };
      events.file({ id, name: file.name, size: file.size, mine: true, progress: 0 });
      let timer;
      const receipt = new Promise((resolve, reject) => { receipts.set(id, { resolve, reject }); timer = setTimeout(() => reject(new Error('Delivery confirmation timed out.')), 120000); });
      receipt.catch(() => {});
      try {
        await send({ type: 'start', id, name: file.name, size: file.size });
        for (let offset = 0; offset < file.size; offset += 32768) {
          await send({ type: 'chunk', id, data: await file.slice(offset, offset + 32768).arrayBuffer() });
          events.file({ id, progress: Math.min(99, Math.round((offset + 32768) / file.size * 100)) });
        }
        await send({ type: 'finish', id }); await receipt;
        events.file({ id, progress: 100, done: true });
      } catch (error) {
        events.file({ id, error: error.message });
        if (room) request('packet', { type: 'cancel', id }).catch(() => {});
        throw error;
      } finally { clearTimeout(timer); receipts.delete(id); }
    },
    destroy() { disposed = true; cleanup(); socket.disconnect(); }
  };
}
