# Peer link: watching another computer's sessions

One machine (the **sharer**, e.g. the owner's Mac) turns on _Share with my other computers_. Another machine (the **viewer**, e.g. a Windows PC)
pairs with it once and from then on shows the sharer's sessions live, grouped by machine, next to its own. Every app can do both.

The link is **read-only**. The sharer only sends session data. Besides the handshake, the only messages it accepts are
`sub` / `unsub` (start or stop streaming one session's view), `overview` (on/off) and `ping`. Everything else is ignored. No message can act on a
session, a file, a setting or the app. "Open in Claude" on a remote session does nothing except say where the session runs.

Sharing is **off by default**. While it is off there is no TCP listener and no discovery beacon at all.

Code: `src/main/peer/` (frame, crypto, handshake, store, discovery, service), merge rules in `src/core/remote.ts`, IPC area `peers`
(`src/main/ipc/peers.ts`), UI on the _devices_ page.

## Transport

- TCP, default port **47830** (Devices page, or `CLAUDE_VIS_PEER_PORT`). The sharer listens on all interfaces only while sharing is on
  (`CLAUDE_VIS_PEER_BIND` can restrict it, which the tests use to stay on loopback).
- Framing: 4-byte big-endian length + payload. Payloads larger than 64 KiB before authentication, or 16 MiB after, close the connection.
- Before authentication the payload is JSON (handshake messages only). After it, every payload is AES-256-GCM ciphertext of a JSON message.

## Pairing (one time, with a code)

The sharer shows a code like `7KQ4-M2XD`: 8 characters of Crockford base32 from `crypto.randomInt`, so 40 bits. The code is valid for
**10 minutes**, can be used **once**, attempts are limited to one per second, and after **5 wrong attempts** the code is burned and a new one has
to be generated on the sharer.

```
viewer                                           sharer
hello {mode:"pair", v:1}                    ->
                                            <-   pair-salt {salt(16), ns(32)}         (or error: no code / expired / locked / busy)
K      = scrypt(code, salt, N=2^14, r=8, p=1)   (both sides)
Kauth  = HKDF(K, "cvis1 pair auth"), Kbox = HKDF(K, "cvis1 pair box")
pair-proof {nc(32), mac = HMAC(Kauth, "client"|ns|nc),
            box = AES-GCM(Kbox, viewer identity)} ->
                                                 sharer checks mac (constant time). Wrong: count a failure, reply
                                                 error "bad-code", close. Nothing else is sent.
                                            <-   pair-ok {mac = HMAC(Kauth, "server"|ns|nc), box = AES-GCM(Kbox, sharer identity)}
viewer checks the server mac (a fake sharer that doesn't know the code is rejected), stores the sharer's identity.
```

An identity is `{deviceId, name, publicKey}` where `publicKey` is a long-term **Ed25519** key generated on first run and `deviceId` is the first
16 bytes of SHA-256 of that key (each side checks this, so an id can't be paired with someone else's key). Both sides store the other in
`peers.json` in the app's userData (written with mode 0600), the sharer as a _viewer_, the viewer as a _host_ together with the address it used.

Why this is sound without a PAKE:

- A wrong guess teaches the guesser nothing: the sharer answers with a fixed error before revealing its MAC or its identity. Online guessing is capped
  at 5 tries per code against 2^40 codes (a 1 in 2^37 chance), within 10 minutes.
- The viewer sends its MAC first, so a fake sharer could try to brute-force the code offline from it. It would need about 2^39 scrypt evaluations
  (16 MiB each) before the code expires 10 minutes later, which is far out of reach. This is the trade-off for not using a PAKE (Node has none built
  in); it is acceptable because the code is short-lived and single-use.
- Identity keys travel encrypted and authenticated under a key only code holders have, so a man in the middle can't swap them.

## Every later connection (device keys)

```
viewer                                              sharer
hello {mode:"auth", deviceId, nc(32), eph = X25519 public}  ->
                                                    sharer looks up deviceId among its paired viewers (unknown: error, close)
                                               <-   auth-chal {deviceId, ns(32), eph, sig = Ed25519(sharer, "server"|th)}
viewer checks deviceId is the host it meant to reach and the signature against the stored key
auth-resp {sig = Ed25519(viewer, "client"|th)}  ->
                                                    sharer checks the signature against the stored key
th = SHA-256(viewerId | sharerId | nc | ns | ephViewer | ephSharer)
shared = X25519(eph private, other eph public); keys = HKDF-SHA256(shared, salt th, "cvis1 c2s" / "cvis1 s2c")
```

- Mutual authentication with the stored Ed25519 keys. The signatures cover both fresh nonces and both ephemeral keys, so a recorded handshake can't be
  replayed and a man in the middle can't substitute its own ECDH key.
- Fresh X25519 keys per connection give forward secrecy: stealing `peers.json` later doesn't decrypt recorded traffic.
- After the handshake, each direction has its own AES-256-GCM key and a 64-bit message counter that forms the nonce. The receiver only accepts the
  next counter value, so a replayed, reordered, dropped or modified frame fails authentication and closes the connection.
- Handshakes time out after 10 s, at most 8 unauthenticated connections are kept, and anything unexpected closes the connection.

**Un-pairing** removes the device from `peers.json` and closes its connection; its key is never accepted again. When the sharer un-pairs a viewer it
tells it (`revoked`) so the viewer can show that. When a viewer un-pairs, the sharer's entry stays until it is removed there too (it can't be used
without the viewer's private key, which the viewer deletes).

## What is shared

Only what the viewer's UI shows, and only the sharer's own data (never sessions it receives from its own peers):

| message    | content                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| `sessions` | `SessionSummary` for live sessions plus the 50 most recent, with the transcript path and desktop id blanked |
| `view`     | the live `SessionView` of a session the viewer subscribed to, as `core/sync.ts` full/delta messages         |
| `overview` | live sessions for the all-sessions page (logs trimmed), only while the viewer has that page open            |
| `inbox`    | the sharer's own inbox items (its usage items are left out; usage is merged separately)                     |
| `usage`    | the computed `UsageView` (percentages and reset times). Never the OAuth token or a raw API response         |

Nothing else: no file contents beyond what a view already holds, no settings, no credentials.

On the viewer, remote sessions get ids like `remote:<deviceId>:<sessionId>` and a `machine` name, the inbox merges remote items labelled by machine,
and the usage meters take the freshest reading of each window from any machine (same account), which also covers an expired local login.

## Discovery

The sharer broadcasts a small UDP beacon (port 47831, every 3 s, to 255.255.255.255 and each interface's broadcast address):
`{app:"claude-visualized", v:1, name, port, id}` where `id` is a hash prefix of the device id. No session data. Viewers listen only while the
Devices page is open. Discovery is a convenience: you can always type `host:port`, which is also how to reach a machine over Tailscale
(`my-mac.tailnet.ts.net:47830` or its 100.x address); nothing else is needed for Tailscale.

## Robustness

- Pings every 10 s in both directions; a link with no traffic for 30 s is dropped.
- The viewer reconnects with exponential backoff (1 s doubling to 30 s, with jitter).
- When a sharer goes away, its sessions stay in the list as not live with "offline since …", its live views and inbox items are dropped, and its
  last usage reading simply ages out of the freshest-wins rule.

## Firewall prompts (sharer side)

- **Windows**: the first time the app listens on the network, Windows Defender Firewall asks whether to allow "Claude Visualized" on private / public
  networks. Allow **private** networks. Discovery listening on a viewer can trigger the same prompt; you can deny it and type the host instead.
- **macOS**: with the application firewall on, macOS asks "Do you want the application Claude Visualized to accept incoming network connections?".
  Click **Allow**. Because the app is unsigned, macOS may ask again after an update. You can also add it under System Settings → Network → Firewall →
  Options.

## Known limits

- The pairing code is not a PAKE: see the offline-guessing note above.
- Follow mode only follows local sessions; remote sessions are opened by clicking them. Replay is local-only.
- `peers.json` holds the private key in plain form (mode 0600, like an SSH key); anyone who can read the user's profile can impersonate the device
  until it is un-paired on the other side.
- Un-pairing on the viewer does not notify the sharer (the sharer accepts no commands); remove the viewer there too.
