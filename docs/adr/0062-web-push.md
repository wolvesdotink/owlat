# ADR-0062: Web Push — server-side decisions on the desktop's rules

## Status

Accepted.

## Context

Only the Tauri desktop app could notify anyone. It does so client-side: a
live Convex subscription (`mail.mailbox.queries.newestUnreadInbox`) feeds a
pure rules module (`lib/desktop/notificationRules`) that applies the "Notify
me about" scope, conversation mute, the "Alert on reply" opt-in and quiet
hours, then fires a native toast. That works because the app is running.

A browser tab that is closed runs nothing, and a phone with Owlat on its Home
Screen is closed almost all the time. Web Push (RFC 8030) is the one way to
reach either: the server hands an encrypted message to the browser vendor's
push service, which wakes the site's service worker. So the decision "should
this person be interrupted" has to move to the server for push, while the
desktop keeps making it locally.

## Decision

### 1. One rule set, two evaluators

The scope, mute, reply-alert and quiet-hours rules moved into
`@owlat/shared/notificationRules`. The desktop module re-exports them and
evaluates quiet hours on its own clock; the push sender (`push/dispatch.ts`)
evaluates the same functions against the same `mailUserSettings` row. Quiet
hours are minutes of LOCAL time, so each push subscription records the IANA
time zone its device reported and the window is evaluated per device
(`localClockIn`). What a window holds back is counted per device and sent as
one summary when it closes, the same roll-up the desktop shows.

Assignments keep the desktop's rule (everything but "Nothing", quiet hours do
not apply). Chat mentions and DMs, which the desktop never notified, are
treated as mail from a person.

### 2. Producers enqueue a reference, the sender decides later

Mail delivery (`deliveryPipeline/afterInsert`), assignment and clarification
notices, and the chat insert call `push/events.enqueuePush`, which costs one
env read and one indexed read and schedules nothing when push is off or the
person has no device. The scheduled action re-reads the event by id, so a
message read, muted or deleted in between does not notify, a surface whose
flag was turned off does not either, and no mail content sits in the
scheduler's argument log. A push problem can never fail the write that
produced it.

### 3. The protocol is implemented here, not imported

`lib/webPush.ts` implements RFC 8291 (aes128gcm message encryption) and
RFC 8292 (VAPID) on Web Crypto, a couple of hundred lines pinned byte for byte to the
RFC 8291 example. The `web-push` package would add an HTTP client, a GCM
fallback and a CLI to the backend bundle for the same two HKDF calls, one
AES-GCM seal and one ES256 signature.

### 4. Endpoints are user-supplied URLs

A subscription endpoint comes from the browser, which means a signed-in user
can submit any URL. It is shape-checked at write time (https, no credentials,
no literal private address) and every push goes through `lib/ssrfGuard`
`fetchGuarded` (DNS-checked at connect time, no redirects, 10 s timeout).
Endpoints and keys never leave the backend in a query result or the account
export; the device list shows a label derived in the browser ("Chrome on
macOS"), never a raw user-agent string. 404/410 from a push service deletes
the subscription.

### 5. Privacy is the existing preference

"Private notifications" is `mailUserSettings.isHidePreviewOn`, the desktop's
"Hide message previews", so one switch governs both surfaces. Sealed (E2EE)
mail never puts sender or subject into a payload regardless of it.

### 6. One service worker

A browser keeps one worker per scope and a push subscription belongs to that
registration, so push lives in the existing offline-shell worker
(`service-worker/sw.js`). Where the shell must not run (the
`NUXT_PUBLIC_OFFLINE_SHELL=false` kill switch, the dev server) the page
registers the same script as `/sw.js?shell=off`, which answers no fetch and
keeps no cache. The kill switch downgrades a worker that holds a push
subscription to that mode instead of unregistering it, which would end the
subscription silently.

## Consequences

- Operators need a VAPID key pair (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  optional `VAPID_SUBJECT`). Setup generates it for new installs; without it
  the feature does not appear. Rotating the pair invalidates every
  subscription.
- The backend makes outbound HTTPS requests to the browser vendors' push
  services.
- `pushSubscriptions` is per-user data: member erasure deletes it, workspace
  deletion sweeps it, and the account export lists the devices without their
  keys.
- The desktop and push can drift only if someone changes one evaluator
  without the other; both now import the same functions, and the shared module
  has no copy of either surface's wiring.
