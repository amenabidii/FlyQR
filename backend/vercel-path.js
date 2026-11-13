// Accept both the original Socket.IO URL and the rewritten function URL.
export function normalizeSocketPath(req) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/relay' || url.pathname.startsWith('/api/relay/')) {
    req.url = '/socket.io/' + url.search;
  }
}
