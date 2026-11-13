import { createDistributedRelay } from '../backend/distributed.js';
import { normalizeSocketPath } from '../backend/vercel-path.js';

const relay = await createDistributedRelay({ path: '/socket.io' });
// Vercel may pass the original URL or the rewritten function URL. Normalize both
// before Engine.IO's request/upgrade listeners inspect the Socket.IO path.
relay.http.prependListener('request', normalizeSocketPath);
relay.http.prependListener('upgrade', normalizeSocketPath);
export default relay.http;
