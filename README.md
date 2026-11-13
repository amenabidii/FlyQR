# FlyQR

**Scan. Send. Done.**

FlyQR shares files and messages between two devices without an account. One device creates a room; the other joins by scanning a QR code or entering an eight-character code.

## Features

- Two-device rooms with QR codes and manual joining
- File transfers up to 100 MB, with progress and delivery confirmation
- Direct WebRTC transfers with a Socket.IO relay fallback
- Chat for short messages and links
- Temporary rooms that expire after one hour
- Shared rooms and automatic reconnection on Vercel with Redis

## Local development

Requires Node.js 22 or newer and npm.

```sh
npx --yes pnpm@11.25.0 install --frozen-lockfile
npm run dev
```

The development server runs at [localhost:3000](http://localhost:3000). Local development does not require Redis.

### Testing on a phone

Both devices must be connected to the same Wi-Fi network. Run `ipconfig` on Windows to find the computer's local IPv4 address, then open `http://<computer-ip>:3000` on the computer before creating a room. The QR code will then contain an address accessible from the phone.

Node.js must be allowed through the firewall on the private network. Some public Wi-Fi networks block connections between devices. A deployed HTTPS address works across networks. Clipboard access may be unavailable on local HTTP; QR codes and manual joining remain available.

## Vercel deployment

Vercel serves the Vite frontend from `dist` and the WebSocket backend from `api/relay.js`. Redis shares room state and relay traffic across function instances.

| Setting | Value |
| --- | --- |
| Framework preset | Vite |
| Node.js version | 22.x |
| Install command | `npx --yes pnpm@11.25.0 install --frozen-lockfile --prod=false` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Fluid Compute | Enabled |
| Function duration | 300 seconds |

Build commands, routing and function duration are defined in `vercel.json`. Vercel does not require a start command. Dependencies are installed with pnpm 11.25.0 and the committed lockfile. The frozen install prevents deployment from resolving a different dependency tree. Any dashboard install-command override should match the command above.

### Redis configuration

The backend requires a Redis connection with TCP/TLS, Lua/EVAL and Pub/Sub support. REST-only endpoints are not compatible. Redis can be connected through the [Vercel Marketplace](https://vercel.com/marketplace/redis/redis) or an external provider.

Add `REDIS_URL` under **Settings → Environment Variables** before deployment:

```text
rediss://default:<password>@<host>:<port>
```

The URL must match the provider's TLS settings, with special characters in passwords URL-encoded. `REDIS_URL` is a server-only secret and must not use the `VITE_` prefix. Environment changes require a redeployment. Preview and production deployments should use separate Redis databases.

Public deployments must allow visitors without a Vercel login. Preview deployments can remain protected.

### Deployment verification

Create a room from the public URL and join from a second device. Check messages, file downloads and room closure. Leave the room open for more than five minutes, then send another message to verify connection recovery. Connection errors appear in the Vercel function logs.

### Room storage and reconnection

Redis stores room membership, hashed resume tokens, expiry timestamps and rate-limit counters. Atomic Lua operations enforce the two-device limit. Room keys expire after one hour without relying on a running server timer.

The Socket.IO Redis adapter forwards signaling, messages, file chunks and delivery acknowledgements between function instances. File payloads pass through Redis Pub/Sub in transit; they are not saved as Redis keys or written to disk by FlyQR.

The browser retains a private resume token in page memory and renews the server connection every four minutes. Room membership survives reconnection, but a page refresh loses the token. Disconnected devices retain their reserved slot until the room expires. Closing a room deletes its Redis record immediately; offline devices discover the closure when they reconnect.

Direct WebRTC transfers can continue during signaling reconnection. An interrupted relay transfer may need to be resent. Completed files remain available after a successful reconnect.

### Hosting limits

Vercel and Redis quotas apply separately. Relay traffic consumes bandwidth and Redis operations; a 100 MB file requires thousands of chunks. Direct transfers reduce server traffic. Free tiers are suitable for limited usage, not unlimited file sharing.

## Web Analytics

Vercel Web Analytics is included in production builds through `@vercel/analytics/react`. Enable Web Analytics in the Vercel project dashboard, deploy, then visit the production URL to start collecting page views. Content blockers can prevent collection.

Analytics URLs exclude query strings and fragments, including room codes. File contents, filenames and chat messages are not sent as custom events. Support, About and Contact are overlays on the same page, not separate page routes.

## Standalone hosting

```sh
npx --yes pnpm@11.25.0 install --frozen-lockfile
npm run build
npm start
```

The server listens on `PORT`, defaulting to `3000`. Production hosting requires HTTPS and WebSocket support. A Dockerfile is included.

Without `REDIS_URL`, rooms are held in one Node.js process and close when either device disconnects. With `REDIS_URL`, the standalone server uses the distributed backend. Static hosting of `dist` alone does not provide room creation or transfers.

For local development with Redis, set `REDIS_URL` in the environment or create a private `.env` file based on `.env.example`:

```sh
node --env-file=.env server.js --dev
```

## Privacy and transfer behavior

- Anyone with a room code can join while a slot is available.
- QR codes are generated in the browser. Google STUN assists direct WebRTC connections.
- Files use ordered chunks with backpressure. Delivery is confirmed by the receiving browser.
- Both pages must remain open during a transfer. Interrupted files do not support partial-transfer resume.
- Direct WebRTC traffic is encrypted by the browser. Relay traffic uses HTTPS/WSS in production but is not end-to-end encrypted: the server and Redis provider process bytes in transit.
- Received files remain in browser memory until the room closes. Closing a room revokes its download links but does not delete files already saved to the device.
- Room-attempt limits use the forwarded client IP on Vercel and the direct connection IP on standalone servers. Standalone reverse proxies may group visitors under one address.
- Large public deployments need additional connection and bandwidth controls, abuse monitoring and load testing.

## Tests

```sh
npm test
npm run build
```

The base suite covers pairing, capacity, binary relay integrity, unauthorized access, expiry, disconnect cleanup and rate limiting.

Distributed tests require `TEST_REDIS_URL`. They run two relay servers against isolated, short-lived Redis keys and cover concurrent joins, cross-server transfers, invalid resume tokens, reconnection, URL routing and connection rotation. Without that variable, distributed tests are skipped.

```powershell
$env:TEST_REDIS_URL='redis://127.0.0.1:6379'
node --test
```

Browser checks cover both transfer directions, empty files, downloaded byte integrity, mobile layouts and end-room cleanup.

## References

- [Vercel WebSockets](https://vercel.com/docs/functions/websockets)
- [Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Redis Cloud setup](https://redis.io/docs/latest/operate/rc/rc-quickstart/)
- [Socket.IO server options](https://socket.io/docs/v4/server-options/)
- [WebRTC data-channel buffering](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount)
