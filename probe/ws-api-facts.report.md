# node:http + ws API facts

Generated 2026-08-28T08:07:12.875Z by `probe/ws-api-facts.mjs`.

- Node version: **v24.13.1**
- ws version: **8.21.3**
- Platform: win32/x64

Observed behavior only; interpretation lives in the adapter design docs.
Re-run after every Node or ws upgrade; review any diff before trusting the upgrade.

## send-and-backpressure

- ws.send() return value
  - undefined
- bufferedAmount right after a small send
  - 0
- send(data, cb) - observed order
  - ["send-returned","callback"]
- bufferedAmount during a 24x1MiB burst (iteration:value)
  - ["0:0","8:7340102","16:15728790"]
- bufferedAmount unit
  - bytes (grew past 1000 on MiB frames)
- does the send callback fire once the peer reads (a drain signal)
  - yes
- bufferedAmount after the peer drained
  - 0

## closed-socket

- readyState after the client closed
  - 3 (CLOSED=3)
- ws.send() on a closed socket
  - did NOT throw
- send(data, cb) on a closed socket reports
  - error: WebSocket is not open: readyState 3 (CLOSED)
- bufferedAmount on a closed socket
  - 25
- ws.ping() on a closed socket
  - did NOT throw
- ws.close() on an already closed socket
  - did NOT throw

## pubsub-surface

- uWS socket methods present on a ws socket
  - NONE - every one of them is facade work
- a publish()/topic surface on WebSocketServer
  - absent - fan-out is a JS registry walk
- underlying net.Socket reachable for cork/writev
  - yes, via the private _socket field

## upgrade-flow

- handshake completed after an await before handleUpgrade
  - yes - the socket survived the await
- destroying the socket mid-upgrade
  - refused: client error: socket hang up

## upgrade-headers

- subprotocol chosen by handleProtocols
  - "v2"

## limits-and-compression

- close code when a client frame exceeds maxPayload
  - 1009 ""
- what the server socket reports for that frame
  - WS_ERR_UNSUPPORTED_MESSAGE_LENGTH: Max payload size exceeded
- perMessageDeflate negotiated with the client
  - "permessage-deflate"
- per-message { compress: false } option
  - accepted

## ping-and-idle

- the client answered a server ping
  - yes, payload "probe"
- a built-in idleTimeout option on WebSocketServer
  - ABSENT - the idle timer is adapter work (JS timer plus ping/pong)

## message-buffer

- a binary frame arrives as
  - Buffer, isBinary=true
- a text frame arrives as
  - Buffer, isBinary=false
- is the first frame buffer mutated by a later frame
  - no, still 01020304

## prototype-patch

- ws.WebSocket.prototype accepts a new method
  - visible on a live socket, returns stamped
- the stamp is visible on a socket opened afterwards
  - yes

## shutdown-drain

- http.close() callback fired while a WebSocket was open
  - NO - the callback waits on the live socket, so shutdown must close sockets itself
- WebSocket readyState after http.close()
  - 1 (OPEN=1)
- a send still reaches the client after http.close()
  - yes - live sockets survive the HTTP close, so a managed drain is adapter work

## listen-options

- server.listen({ reusePort: true }) on this Node
  - refused: ENOTSUP

## kit-primitives

- public @sveltejs/kit/node exports available
  - ["getRequest","setResponse","createReadableStream"]

## tls

- in-process TLS via node:https with ws mounted on the https server
  - MANUAL - needs certs; run separately and record the result here
- SNI callback, multiple certs, OCSP stapling
  - MANUAL - node:tls surface, not probed
