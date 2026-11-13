// Unlike randomUUID, getRandomValues is available on local HTTP connections.
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
