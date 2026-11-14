import express from 'express';
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from 'socket.io';

export function createRelay({ ttl = 1200000, path = '/socket.io' } = {}) {
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
  const roster = room => room.members.map(id => ({ id, name: io.sockets.sockets.get(id)?.data.name || 'Guest', host: id === room.members[0] }));
  const announce = room => io.to(room.code).emit('members', roster(room));
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
    socket.on('feedback', (_, ack) => reply(ack, { error: 'Feedback requires the Redis backend. Please try the hosted website.' }));
    socket.on('check-room', (raw, ack) => {
      if (!limit()) return reply(ack, { error: 'Too many attempts. Try again in a minute.' });
      const room = rooms.get(String(raw || '').trim().toUpperCase());
      reply(ack, !room ? { error: 'Room not found or expired.' } : room.members.length >= 5 ? { error: 'This room is full (5 devices).' } : { ok: true });
    });
    socket.on('create', (_, ack) => {
      if (!limit()) return reply(ack, { error: 'Too many attempts. Try again in a minute.' });
      if (socket.data.code) return reply(ack, { error: 'Leave your current room first.' });
      if (rooms.size >= 1000) return reply(ack, { error: 'The server is busy. Try again shortly.' });
      let code;
      do { code = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
      const expires = Date.now() + ttl;
      const timer = setTimeout(() => close(code, 'This room has expired.'), ttl); timer.unref();
      rooms.set(code, { code, members: [socket.id], expires, timer, guestCount: 0 });
      socket.data.name = 'Host';
      socket.data.code = code; socket.join(code);
      reply(ack, { code, expires, host: true, memberId: socket.id, members: roster(rooms.get(code)) });
    });
    socket.on('join', (raw, ack) => {
      if (!limit()) return reply(ack, { error: 'Too many attempts. Try again in a minute.' });
      if (socket.data.code) return reply(ack, { error: 'Leave your current room first.' });
      const code = String(typeof raw === 'string' ? raw : raw?.code || '').toUpperCase().replace(/[\s-]/g, '');
      const room = rooms.get(code);
      if (!room) return reply(ack, { error: 'Room not found. Check the code or create a new room.' });
      if (room.members.length >= 5) return reply(ack, { error: 'This room is full (5 devices).' });
      room.guestCount++; socket.data.name = String(raw?.name || '').trim().slice(0,30) || `Guest ${room.guestCount}`;
      room.members.push(socket.id); socket.data.code = code; socket.join(code);
      reply(ack, { code, expires: room.expires, host: false, memberId: socket.id, members: roster(room) });
      announce(room);
      io.to(code).emit('paired');
    });
    socket.on('signal', (data, ack) => {
      const room = rooms.get(socket.data.code);
      if (!room || !room.members.includes(socket.id) || !data || JSON.stringify(data).length > 70000) return reply(ack, { error: 'Invalid signal.' });
      const host = room.members[0];
      const target = socket.id === host ? data.to : host;
      if (target === socket.id || !room.members.includes(target)) return reply(ack, { error: 'Choose a connected guest.' });
      io.to(target).emit('signal', { ...data, from: socket.id, senderName: socket.data.name }); reply(ack, { ok: true });
    });
    socket.on('kick', (target, ack) => {
      const room = rooms.get(socket.data.code);
      if (!room || room.members[0] !== socket.id || target === socket.id || !room.members.includes(target)) return reply(ack, { error: 'Only the host can remove guests.' });
      room.members = room.members.filter(id => id !== target);
      const guest = io.sockets.sockets.get(target);
      if (guest) { guest.emit('ended', 'The host removed you from the room.'); guest.leave(room.code); guest.data.code = null; }
      announce(room); reply(ack, { ok: true });
    });
    function leave() {
      const room = rooms.get(socket.data.code);
      if (!room) return;
      if (room.members[0] === socket.id) close(room.code, 'The host closed the room.');
      else { room.members = room.members.filter(id => id !== socket.id); socket.leave(room.code); socket.data.code = null; announce(room); }
    }
    socket.on('leave', (_, ack) => { leave(); reply(ack, { ok: true }); });
    socket.on('end', (_, ack) => { const room = rooms.get(socket.data.code); if (room?.members[0] !== socket.id) return reply(ack, { error: 'Only the host can close the room.' }); close(socket.data.code, 'The room was closed.'); reply(ack, { ok: true }); });
    socket.on('disconnect', leave);
  });
  http.on('close', () => { clearInterval(sweep); for (const r of rooms.values()) clearTimeout(r.timer); });
  app.get('/health', (_, res) => res.json({ ok: true }));
  return { app, http, io, rooms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv.includes('--dev') ? '/socket.io' : '/api/relay';
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
