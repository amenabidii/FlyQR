import { createDistributedRelay } from '../backend/distributed.js';

const relay = await createDistributedRelay({
  path: '/api/relay/socket.io'
});

export default relay.http;