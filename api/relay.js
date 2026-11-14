import { createDistributedRelay } from '../backend/distributed.js';
import { normalizeSocketPath } from '../backend/vercel-path.js';

console.log('FlyQR configuration check:', {
  redisConfigured: Boolean(process.env.REDIS_URL),
  environment: process.env.VERCEL_ENV,
  runningOnVercel: Boolean(process.env.VERCEL)
});

const relay = await createDistributedRelay({
  path: '/socket.io'
});

relay.http.prependListener('request', normalizeSocketPath);
relay.http.prependListener('upgrade', normalizeSocketPath);

export default relay.http;