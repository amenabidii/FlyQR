// getRandomValues also works on HTTP LAN addresses during local development.
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
