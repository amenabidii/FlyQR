import { randomBytes, randomInt, createHash } from 'node:crypto';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const digest = token => createHash('sha256').update(token).digest('hex');
// Admission and session recovery are atomic; reconnecting preserves the original expiry.
const update = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({error='Room not found or expired.'}) end
local r = cjson.decode(raw)
local action = ARGV[1]
local token = ARGV[2]
local socket = ARGV[3]
local member = nil
for i,m in ipairs(r.members) do if m.token == token then member = m end end
if action == 'join' then
  if #r.members >= 2 then return cjson.encode({error='This room already has two devices.'}) end
  member = {token=token, socket=socket, host=false}
  table.insert(r.members, member)
else
  if not member then return cjson.encode({error='Invalid room credential.'}) end
  if action == 'resume' then member.socket = socket
  elseif member.socket ~= socket then return cjson.encode({error='This connection has been replaced.'}) end
end
if action == 'end' then redis.call('DEL', KEYS[1])
elseif action == 'join' or action == 'resume' then
  redis.call('SET', KEYS[1], cjson.encode(r), 'KEEPTTL')
end
return cjson.encode({room=r, host=member.host})
`;

export class RedisRooms {
  constructor(redis, { prefix = 'flyqr:', ttl = 1200000 } = {}) { this.redis = redis; this.prefix = prefix; this.ttl = ttl; }
  async limit(ip) {
    const key = this.prefix + 'rate:' + digest(ip);
    const count = await this.redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", { keys: [key], arguments: [] });
    if (count > 30) throw new Error('Too many attempts. Try again in a minute.');
  }
  async create(socket) {
    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + this.ttl;
    for (let i = 0; i < 5; i++) {
      const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
      const room = { code, expires, members: [{ token: digest(token), socket, host: true }] };
      if (await this.redis.set(this.prefix + 'room:' + code, JSON.stringify(room), { NX: true, PX: this.ttl })) return { code, token, expires, host: true };
    }
    throw new Error('Could not create a room. Try again.');
  }
  async act(action, code, token, socket) {
    if (!/^[A-Z2-9]{8}$/.test(code || '') || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid room credential.');
    const result = JSON.parse(await this.redis.eval(update, { keys: [this.prefix + 'room:' + code], arguments: [action, digest(token), socket] }));
    if (result.error) throw new Error(result.error);
    return result;
  }
  async join(code, socket) {
    const token = randomBytes(32).toString('hex');
    const { room } = await this.act('join', code, token, socket);
    return { code, token, expires: room.expires, host: false };
  }
}
