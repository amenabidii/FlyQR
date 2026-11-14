import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { RedisRooms } from './rooms.js';

export async function createDistributedRelay({ url = process.env.REDIS_URL, prefix = 'flyqr:', ttl, rotateMs = 240000, path = '/api/relay/socket.io' } = {}) {
console.log('FlyQR Redis configuration:', {
  redisUrlPresent: Boolean(process.env.REDIS_URL),
  urlArgumentPresent: Boolean(url),
  environment: process.env.VERCEL_ENV
});  
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
    const roster = room => room.members.map(m => ({ id: m.token, name: m.name || (m.host ? 'Host' : 'Guest'), host: m.host }));
    const announce = room => io.to(room.code).emit('members', roster(room));
    async function attach(room) {
      socket.data.room = room;
      await socket.join(room.code);
      clearTimeout(expiry);
      expiry = setTimeout(() => { socket.emit('ended', 'This room has expired.'); socket.leave(room.code); socket.data.room = null; }, Math.max(0, room.expires - Date.now())); expiry.unref();
      const state = await rooms.act('read', room.code, room.token, socket.id);
      announce(state.room);
      return { ...room, memberId: state.room.members.find(m => m.socket === socket.id).token, members: roster(state.room) };
    }
    const limit = () => rooms.limit(process.env.VERCEL ? String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address).split(',')[0].trim() : socket.handshake.address);
    handle('feedback', async data => {
      await limit();
      const message = typeof data === 'string' ? data.trim() : '';
      if (!message || message.length > 3000) throw new Error('Please write between 1 and 3,000 characters.');
      await redis.multi().lPush(prefix + 'feedback', JSON.stringify({ message, createdAt: new Date().toISOString() })).lTrim(prefix + 'feedback', 0, 999).exec();
      return { ok: true };
    });
    handle('check-room', async raw => {
      await limit();
      const code = String(raw || '').trim().toUpperCase();
      if (!/^[A-Z2-9]{4}$/.test(code)) throw new Error('Enter a valid four-character room code.');
      const value = await redis.get(prefix + 'room:' + code);
      if (!value) throw new Error('Room not found or expired.');
      if (JSON.parse(value).members.length >= 5) throw new Error('This room is full (5 devices).');
      return { ok: true };
    });
    handle('create', async () => { await limit(); if (socket.data.room) throw new Error('Leave your current room first.'); return attach(await rooms.create(socket.id)); });
    handle('join', async raw => {
      await limit(); if (socket.data.room) throw new Error('Leave your current room first.');
      const code = String(typeof raw === 'string' ? raw : raw?.code || '').toUpperCase().replace(/[\s-]/g, '');
      const room = await attach(await rooms.join(code, socket.id, raw?.name));
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
      if (!data || JSON.stringify(data).length > 70000) throw new Error('Invalid signal.');
      const sender = room.members.find(m => m.socket === socket.id);
      const target = sender.host ? room.members.find(m => m.token === data.to && !m.host) : room.members.find(m => m.host);
      if (!target) throw new Error('Choose a connected guest.');
      io.to(target.socket).emit('signal', { ...data, from: sender.token, senderName: sender.name || 'Host' });
    });
    handle('kick', async target => {
      const r = socket.data.room;
      if (!r) throw new Error('Join a room first.');
      const state = await membership();
      if (!state.host || !state.room.members.some(m => m.token === target && !m.host)) throw new Error('Choose a guest in this room.');
      const targetSocket = state.room.members.find(m => m.token === target).socket;
      const { room } = await rooms.act('kick', r.code, r.token, socket.id, '', targetSocket);
      io.to(targetSocket).emit('ended', 'The host removed you from the room.');
      io.in(targetSocket).socketsLeave(r.code);
      announce(room);
    });
    handle('leave', async () => {
      const r = socket.data.room;
      const { room, host } = await membership('leave');
      if (host) { io.to(room.code).emit('ended', 'The host closed the room.'); io.in(room.code).socketsLeave(room.code); }
      else { socket.leave(room.code); announce(room); }
      socket.data.room = null; clearTimeout(expiry);
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
    socket.on('disconnect', () => {
      clearTimeout(rotation); clearTimeout(expiry);
      const previous = socket.data.room;
      if (!previous) return;
      setTimeout(async () => {
        try {
          const { room, host } = await rooms.act('leave', previous.code, previous.token, socket.id);
          if (host) { io.to(room.code).emit('ended', 'The host disconnected.'); io.in(room.code).socketsLeave(room.code); }
          else announce(room);
        } catch { /* Resumed or already removed. */ }
      }, 15000).unref();
    });
  });
  return { app, http, io, rooms, async shutdown() { await new Promise(r => io.close(r)); await Promise.all(clients.map(c => c.isOpen ? c.quit() : null)); } };
}
