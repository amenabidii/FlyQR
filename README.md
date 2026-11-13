# FlyQR

A temporary bridge between two devices: create a room, scan its QR code, and share files and messages without an account.

## Run locally

Install Node.js 22 or newer (including npm), then open a terminal in this folder:

```sh
npm install
npm run dev
```

Open http://localhost:3000 on your computer. Create a room, or enter an existing eight-character code. QR links prefill the code; tap the arrow to join.

### Test with your phone

1. Put both devices on the same Wi-Fi.
2. Find your computer's local IPv4 address (`ipconfig` on Windows).
3. Open `http://YOUR-COMPUTER-IP:3000` **on the computer**, then create the room. This ensures the QR code points to an address the phone can reach.
4. Scan the QR code with your phone. If Windows asks, allow Node.js through the firewall on your private network.

`localhost` always means the device you're using. Public Wi-Fi may block communication between devices; use a deployed HTTPS URL for the actual library use case. Clipboard copying may be unavailable on local HTTP; the QR code and manual code still work.

## Production

```sh
npm install
npm run build
npm start
```

Run this as **one persistent Node.js service** behind HTTPS, with WebSocket support. Set `PORT` if your host requires it (default 3000). Build command: `npm install && npm run build`; start command: `npm start`. The included Dockerfile is another deployment option. This is not a static-only website: uploading `dist` to a static host won't run the room server. No hosting account or paid service is needed for local use. Deployment has not been configured for your account.

## Behavior and limits

- React + Vite frontend; Express + Socket.IO server; QR codes generated locally.
- Two devices per room. Random eight-character codes, one-hour expiry, and rate-limited room attempts. Anyone with the code can join until the room is full; share codes only with your own device.
- Files use an ordered WebRTC data channel when available. Google STUN helps establish the connection. If direct connectivity is unavailable, file chunks use the Socket.IO server relay instead. TURN is not required for that fallback.
- 100 MB per file. Files are chunked with backpressure; the receiving browser confirms completion. Keep both pages open and phones awake. Failed transfers must be resent; there is no resume across disconnections.
- Chat and file relay traffic use HTTPS/WSS when deployed with HTTPS. **Relay traffic is not end-to-end encrypted**; the server processes bytes in transit. File content is never written to disk by this application. Direct WebRTC channels are encrypted by the browser.
- Received files live in browser memory until the room closes. Download them before leaving. Closing a room revokes download links and clears the interface; it does not remove files already saved to a computer.
- Disconnecting either device ends the room. Server restarts erase every room. Horizontal scaling needs a shared room store and Socket.IO adapter; this version intentionally uses a single server.
- Before a large public launch, add reverse-proxy connection/bandwidth limits, abuse monitoring, and load testing. Current room-attempt limits use the direct connection IP, which may group users behind a reverse proxy.

## Checks

```sh
npm test
npm run build
```

Tests exercise real Socket.IO clients for pairing, room capacity, relay byte integrity, unauthorized relay rejection, expiry, disconnect cleanup, and rate limiting. For browser validation, use two tabs/devices to send a message, a file, and an empty file both ways; verify downloaded bytes and end-room cleanup. Use a mobile viewport and test both direct and relay modes.

Protocol references: [Socket.IO server options](https://socket.io/docs/v4/server-options/) and [WebRTC data-channel buffering](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount).
