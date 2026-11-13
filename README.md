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

## Deploy on Vercel

The frontend is static; `api/relay.js` is a WebSocket function. **Redis is required on Vercel** so devices can find the same room even when they connect to different function instances.

1. Import `amenabidii/FlyQR` from GitHub into Vercel. Use the **Vite** preset and Node.js **22.x**. The tracked `vercel.json` sets the install/build commands and output directory. Do not add a start command.
2. Add a Redis database through [Vercel Marketplace](https://vercel.com/marketplace/redis/redis), or connect a compatible external Redis database. Select the free option only if offered and suitable for your usage. Redis Cloud has a free prototype tier. This app needs **TCP/TLS, Lua/EVAL and Pub/Sub**; a REST-only connection will not work.
3. In Vercel **Settings → Environment Variables**, set `REDIS_URL` to your provider's full connection URL, for example `rediss://default:PASSWORD@HOST:PORT`. Use the provider's TLS configuration and URL-encode special characters in passwords. The example is not a real credential. Never put this value in source code or a `VITE_` variable. A provider integration may create it for you; verify the variable name.
4. Enable **Fluid Compute**. The function duration is set to 300 seconds. Deploy (or redeploy after adding the variable).
5. Open the public deployment URL on two devices, create/join a room, and send a file. Keep the room open for more than five minutes and send another message: the client should reconnect without discarding the room. Check Vercel logs for connection errors without sharing credentials.

For public visitors, ensure production Deployment Protection does not require Vercel login. Preview deployments can remain protected. Use a separate Redis database for previews to isolate them from production.

### How the Vercel backend works

- Redis stores only room membership, hashed resume tokens, expiration and rate-limit counters. An atomic Lua operation prevents two simultaneous joins from exceeding room capacity. Keys expire automatically after one hour; timers are not required to remove room records.
- Socket.IO uses WebSocket transport only. The Redis Pub/Sub adapter forwards signals, chat and file chunks between function instances, including delivery acknowledgements. It does not write file payloads to Redis keys or disk; relay content passes through the Redis provider in transit.
- Clients retain a private resume token in page memory, rotate the server connection at four minutes, and resume the same room. Refreshing the page loses the token; create a new room in that case. Keep both pages open.
- Direct WebRTC transfers can continue during signaling reconnection. A relay transfer interrupted while a chunk is in flight may fail and must be resent; it is never silently marked delivered. Completed downloads remain available through a successful reconnect.
- Closing the room invalidates its Redis record immediately. An offline device discovers closure when it reconnects. Disconnected devices keep their reserved slot until room expiry, allowing reconnection.
- Free plans have bandwidth, command, connection and compute quotas. A 100 MB relay transfer involves thousands of chunks and Redis operations. Free hosting is **not unlimited file sharing**. Monitor both Vercel and Redis usage; file relay traffic consumes their allowances. Direct WebRTC reduces that traffic.

References: [Vercel WebSockets and Socket.IO](https://vercel.com/docs/functions/websockets), [function duration](https://vercel.com/docs/functions/configuring-functions/duration), [Redis Cloud free database](https://redis.io/docs/latest/operate/rc/rc-quickstart/).

## Run a standalone production server

```sh
npm install
npm run build
npm start
```

Without `REDIS_URL`, this runs as **one persistent Node.js service** behind HTTPS, with WebSocket support. Set `PORT` if your host requires it (default 3000). Build command: `npm install && npm run build`; start command: `npm start`. With `REDIS_URL`, the standalone server uses the same distributed backend as Vercel. The included Dockerfile is another deployment option. Uploading only `dist` won't run the room server. No Redis account or paid service is needed for local single-server use.

## Behavior and limits

- React + Vite frontend; Express + Socket.IO server; QR codes generated locally.
- Two devices per room. Random eight-character codes, one-hour expiry, and rate-limited room attempts. Anyone with the code can join until the room is full; share codes only with your own device.
- Files use an ordered WebRTC data channel when available. Google STUN helps establish the connection. If direct connectivity is unavailable, file chunks use the Socket.IO server relay instead. TURN is not required for that fallback.
- 100 MB per file. Files are chunked with backpressure; the receiving browser confirms completion. Keep both pages open and phones awake. Failed transfers must be resent; there is no resume across disconnections.
- Chat and file relay traffic use HTTPS/WSS when deployed with HTTPS. **Relay traffic is not end-to-end encrypted**; the server and Redis Pub/Sub provider process bytes in transit. File content is never written to disk by this application. Direct WebRTC channels are encrypted by the browser.
- Received files live in browser memory until the room closes. Download them before leaving. Closing a room revokes download links and clears the interface; it does not remove files already saved to a computer.
- In local mode without Redis, disconnecting either device ends the room and server restarts erase rooms. In Vercel/Redis mode, rooms survive socket disconnects and process restarts until their original expiry.
- Before a large public launch, add reverse-proxy connection/bandwidth limits, abuse monitoring, and load testing. Current room-attempt limits use the direct connection IP, which may group users behind a reverse proxy.

## Checks

```sh
npm test
npm run build
```

Tests exercise real Socket.IO clients for pairing, room capacity, relay byte integrity, unauthorized relay rejection, expiry, disconnect cleanup, and rate limiting. For browser validation, use two tabs/devices to send a message, a file, and an empty file both ways; verify downloaded bytes and end-room cleanup. Use a mobile viewport and test both direct and relay modes.

Distributed tests are skipped unless `TEST_REDIS_URL` points to a local/test Redis database. They create isolated short-lived keys and run two separate relay servers, exercising concurrent admission, cross-server binary delivery, forged token rejection, reconnects, expiry and automatic connection rotation. In PowerShell:

```powershell
$env:TEST_REDIS_URL='redis://127.0.0.1:6379'
node --test
```

For a local distributed preview, set `REDIS_URL` in your terminal, then run `npm run dev`. Alternatively use `node --env-file=.env server.js --dev` with a private `.env` file based on `.env.example`.

Protocol references: [Socket.IO server options](https://socket.io/docs/v4/server-options/) and [WebRTC data-channel buffering](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount).
