// Rewrites and function routing can deliver either URL shape to the handler.
export function normalizeSocketPath(req) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/relay' || url.pathname.startsWith('/api/relay/')) {
    req.url = '/socket.io/' + url.search;
  }
}
