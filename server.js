import express from 'express';
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from 'socket.io';

export function createRelay({ ttl = 3600000, path = '/socket.io' } = {}) {
  const app = express();
  const http = createServer(app);
  const io = new Server(http, { path, maxHttpBufferSize: 100000, serveClient: false });
  const rooms = new Map();
  const attempts = new Map();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function close(code, reason) {
    const room = rooms.get(code);
    if (!room) return;
    clearTimeout(room.timer);
    for (const id of room.members) {
      const s = io.sockets.sockets.get(id);
      if (s) { s.emit('ended', reason); s.leave(code); s.data.code = null; }
    }
    rooms.delete(code);
  }
  const sweep = setInterval(() => { const now = Date.now(); for (const [ip, entry] of attempts) if (entry.until < now) attempts.delete(ip); }, 60000);
  sweep.unref();
  io.on('connection', socket => {
    const reply = (ack, data) => { if (typeof ack === 'function') ack(data); };
    function limit() {
      const ip = socket.handshake.address;
      let entry = attempts.get(ip);
      if (!entry || entry.until < Date.now()) { entry = { count: 0, until: Date.now() + 60000 }; attempts.set(ip, entry); }
      return ++entry.count <= 30;
    }
    socket.on('create', (_, ack) => {
      if (!limit()) return reply(ack, { error: 'Too many attempts. Try again in a minute.' });
      if (socket.data.code) return reply(ack, { error: 'Leave your current room first.' });
      if (rooms.size >= 1000) return reply(ack, { error: 'The server is busy. Try again shortly.' });
      let code;
      do { code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
      const expires = Date.now() + ttl;
      const timer = setTimeout(() => close(code, 'This room has expired.'), ttl); timer.unref();
      rooms.set(code, { members: [socket.id], expires, timer });
      socket.data.code = code; socket.join(code);
      reply(ack, { code, expires, host: true });
    });
    socket.on('join', (raw, ack) => {
      if (!limit()) return reply(ack, { error: 'Too many attempts. Try again in a minute.' });
      if (socket.data.code) return reply(ack, { error: 'Leave your current room first.' });
      const code = typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '') : '';
      const room = rooms.get(code);
      if (!room) return reply(ack, { error: 'Room not found. Check the code or create a new room.' });
      if (room.members.length >= 2) return reply(ack, { error: 'This room already has two devices.' });
      room.members.push(socket.id); socket.data.code = code; socket.join(code);
      reply(ack, { code, expires: room.expires, host: false });
      io.to(code).emit('paired');
    });
    socket.on('signal', (data, ack) => {
      if (socket.data.code && data && JSON.stringify(data).length < 20000) socket.to(socket.data.code).emit('signal', data);
      reply(ack, { ok: true });
    });
    socket.on('packet', (packet, ack) => {
      const room = rooms.get(socket.data.code);
      if (!room || room.members.length !== 2) return reply(ack, { error: 'The other device is not connected.' });
      if (!packet || !['chat', 'start', 'chunk', 'finish', 'received', 'cancel'].includes(packet.type)) return reply(ack, { error: 'Invalid packet.' });
      // Acknowledge only after the receiving browser has processed this packet.
      socket.to(socket.data.code).timeout(15000).emit('packet', packet, (error, responses) => {
        reply(ack, error ? { error: 'The other device did not respond.' } : responses[0] || { ok: true });
      });
    });
    socket.on('end', (_, ack) => { close(socket.data.code, 'The room was closed.'); reply(ack, { ok: true }); });
    socket.on('disconnect', () => close(socket.data.code, 'A device disconnected. Create a new room to reconnect.'));
  });
  http.on('close', () => { clearInterval(sweep); for (const r of rooms.values()) clearTimeout(r.timer); });
  app.get('/health', (_, res) => res.json({ ok: true }));
  return { app, http, io, rooms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv.includes('--dev') ? '/socket.io' : '/api/relay/socket.io';
  const { app, http } = process.env.REDIS_URL
    ? await (await import('./backend/distributed.js')).createDistributedRelay({ path })
    : createRelay({ path });
  app.use((_, res, next) => { res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  if (process.argv.includes('--dev')) {
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({ server: { middlewareMode: true, hmr: { server: http } }, appType: 'spa' });
    app.use(vite.middlewares);
  } else app.use(express.static('dist'));
  const port = Number(process.env.PORT) || 3000;
  http.listen(port, '0.0.0.0', () => console.log(`FlyQR is ready at http://localhost:${port}`));
}
