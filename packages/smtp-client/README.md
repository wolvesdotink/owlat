# @owlat/smtp-client

An in-house SMTP client we fully control, replacing nodemailer's wire role (see
the 2026-07-11 "Owning the Wire" plan). Node-only.

This package is being built in pieces. What lands here first is the **pure,
socket-free core** — exhaustively testable without any network:

- `src/reply.ts` — multiline reply parser (`250-…` / `250 …` continuation),
  RFC 3463 enhanced-code (`X.Y.Z`) extraction, tolerant of lowercase and
  whitespace-sloppy servers, plus a streaming `ReplyParser` for socket byte
  streams.
- `src/errors.ts` — the structured `SmtpError` taxonomy (`phase` / `secured` /
  `tlsCause` / reply codes). Downstream classifies on these discriminants —
  **never** on log-line strings.
- `src/dotStuff.ts` — a streaming, chunk-boundary-safe dot-stuffing encoder for
  the `DATA` payload (bare-CR/LF normalisation, `\r\n.` → `\r\n..`, terminal
  `\r\n.\r\n`).
- `src/commands.ts` — command serializers with CRLF-injection guards on every
  parameterised field, and the EHLO capability-table parser (SIZE, STARTTLS,
  AUTH mechanisms, PIPELINING, SMTPUTF8, 8BITMIME).

The socket-driven state machine (`SmtpClient.connect` / `.send`, STARTTLS, AUTH)
lands in a later piece.

## Locked decisions this piece implements

- **D2** body encoding is always 7-bit-safe; dot-stuffing is deterministic and
  byte-stable so DATA is identical across MX retries.
- **STRING-MATCHING ON ERROR MESSAGES IS BANNED** — `SmtpError` carries machine
  classifiable `phase` / `tlsCause` / reply codes instead.
