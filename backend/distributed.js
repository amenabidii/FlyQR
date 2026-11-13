import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { RedisRooms } from './rooms.js';

export async function createDistributedRelay({ url = process.env.REDIS_URL, prefix = 'flyqr:', ttl, rotateMs = 240000, path = '/api/relay/socket.io' } = {}) {
  if (!url) throw new Error('Set REDIS_URL to a Redis TCP/TLS connection URL before deploying FlyQR.');
  const redis = createClient({ url, socket: { connectTimeout: 10000 }, disableOfflineQueue: true });
  const pub = redis.duplicate(), sub = redis.duplicate();
  const clients = [redis, pub, sub];
  clients.forEach(c => c.on('error', () => console.error('FlyQR Redis connection unavailable')));
  try { await Promise.all(clients.map(c => c.connect())); }
  catch (e) { clients.forEach(c => { if (c.isOpen) c.disconnect(); }); throw e; }
  const rooms = new RedisRooms(redis, { prefix, ttl });
  const app = express(); const http = createServer(app);
  const io = new Server(http, { path, transports: ['websocket'], maxHttpBufferSize: 100000, serveClient: false });
  io.adapter(createAdapter(pub, sub, { key: prefix + 'socket', requestsTimeout: 15000 }));
  app.get('/health', (_, res) => res.json({ ok: redis.isReady && pub.isReady && sub.isReady }));
  io.on('connection', socket => {
    let expiry;
    const rotation = setTimeout(() => socket.emit('rotate'), rotateMs); rotation.unref();
    function handle(name, fn) {
      socket.on(name, async (data, ack) => {
        try { const result = await fn(data); if (typeof ack === 'function') ack(result || { ok: true }); }
        catch (error) { if (typeof ack === 'function') ack({ error: error.message }); }
      });
    }
    async function membership(action = 'read') {
      const r = socket.data.room;
      if (!r) throw new Error('Join a room first.');
      return rooms.act(action, r.code, r.token, socket.id);
    }
    async function attach(room) {
      socket.data.room = room;
      await socket.join(room.code);
      clearTimeout(expiry);
      expiry = setTimeout(() => { socket.emit('ended', 'This room has expired.'); socket.leave(room.code); socket.data.room = null; }, Math.max(0, room.expires - Date.now())); expiry.unref();
      return room;
    }
    const limit = () => rooms.limit(process.env.VERCEL ? String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address).split(',')[0].trim() : socket.handshake.address);
    handle('create', async () => { await limit(); if (socket.data.room) throw new Error('Leave your current room first.'); return attach(await rooms.create(socket.id)); });
    handle('join', async raw => {
      await limit(); if (socket.data.room) throw new Error('Leave your current room first.');
      const code = typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '') : '';
      const room = await attach(await rooms.join(code, socket.id));
      // Give the client time to process the join acknowledgement before negotiating.
      setTimeout(() => io.to(code).emit('paired'), 50).unref();
      return room;
    });
    handle('resume', async data => {
      if (socket.data.room) throw new Error('Already in a room.');
      const result = await rooms.act('resume', data?.code, data?.token, socket.id);
      const room = await attach({ code: result.room.code, token: data.token, expires: result.room.expires, host: result.host });
      if (result.room.members.length === 2) setTimeout(() => io.to(room.code).emit('paired'), 50).unref();
      return room;
    });
    handle('signal', async data => {
      const { room } = await membership();
      if (!data || JSON.stringify(data).length > 20000) throw new Error('Invalid signal.');
      const other = room.members.find(m => m.socket !== socket.id);
      if (other) io.to(other.socket).emit('signal', data);
    });
    handle('packet', async packet => {
      const { room } = await membership();
      if (!packet || !['chat', 'start', 'chunk', 'finish', 'received', 'cancel'].includes(packet.type)) throw new Error('Invalid packet.');
      const other = room.members.find(m => m.socket !== socket.id);
      if (!other) throw new Error('The other device is not connected.');
      const replies = await io.to(other.socket).timeout(15000).emitWithAck('packet', packet);
      if (replies.length !== 1) throw new Error('The other device is reconnecting. Please resend.');
      return replies[0];
    });
    handle('end', async () => {
      const { room } = await membership('end');
      io.to(room.code).emit('ended', 'The room was closed.');
      io.in(room.code).socketsLeave(room.code);
      socket.data.room = null; clearTimeout(expiry);
    });
    socket.on('release', () => {
      if (socket.data.room) socket.leave(socket.data.room.code);
      socket.data.room = null; clearTimeout(expiry);
    });
    socket.on('disconnect', () => { clearTimeout(rotation); clearTimeout(expiry); });
  });
  return { app, http, io, rooms, async shutdown() { await new Promise(r => io.close(r)); await Promise.all(clients.map(c => c.isOpen ? c.quit() : null)); } };
}
