import { createDistributedRelay } from '../backend/distributed.js';
import { normalizeSocketPath } from '../backend/vercel-path.js';

const relay = await createDistributedRelay({
  path: '/socket.io'
});

relay.http.prependListener('request', normalizeSocketPath);
relay.http.prependListener('upgrade', normalizeSocketPath);

export default relay.http;
