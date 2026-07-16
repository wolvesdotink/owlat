/**
 * Public types for the in-house SMTP listener.
 *
 * This package replaces `smtp-server` on Owlat's inbound path (port-25 MX and
 * the 587/465 submission listener). L1 provides the raw-`net` command loop, the
 * byte budget and the timeout skeleton with NO TLS/AUTH — those are layered on
 * in L2. The public API mirrors what the bounce/submission servers need from
 * `smtp-server` today so the L2/L3 cutover is a drop-in.
 */

import type { SmtpAuthConfig } from './auth.js';
import type { SmtpTlsConfig } from './tls.js';

/**
 * A structured SMTP reply. Serialized byte-exactly by {@link module:reply}.
 *
 *  - `code`      three-digit SMTP reply code (RFC 5321 §4.2.1).
 *  - `enhanced`  optional RFC 3463 enhanced status code, e.g. `"5.2.2"`. When
 *                present it is emitted after the reply code on every line
 *                (RFC 2034 / RFC 3463).
 *  - `text`      human-readable text. An array produces a multiline reply
 *                (used for EHLO capability lists).
 */
export interface SmtpReply {
	code: number;
	enhanced?: string;
	text: string | string[];
}

/**
 * A parsed MAIL FROM / RCPT TO address with its ESMTP parameters, e.g.
 * `MAIL FROM:<a@b> SIZE=1024 BODY=8BITMIME` → `{ address: 'a@b', params: {
 * SIZE: '1024', BODY: '8BITMIME' } }`. Value-less params (e.g. `SMTPUTF8`) map
 * to the empty string.
 */
export interface SmtpAddress {
	address: string;
	params: Record<string, string>;
}

/**
 * Per-connection SMTP session. `S` is caller-supplied session state (attached
 * by {@link SmtpListenerOptions.createSession}); `T` is caller-supplied
 * per-transaction state, reset on RSET / after DATA / on a fresh MAIL FROM.
 */
export interface SmtpSession<S = unknown, T = unknown> {
	/** Monotonic per-listener connection id (for logging / correlation). */
	readonly id: string;
	readonly remoteAddress: string;
	readonly remotePort: number;
	readonly localAddress: string;
	readonly localPort: number;
	/**
	 * Whether the underlying socket is TLS. Set for implicit-TLS connections and
	 * flipped to `true` by a successful STARTTLS upgrade (RFC 3207). `readonly` in
	 * the public type: only the command loop owns the security posture, so a
	 * handler cannot forge it (mutated internally via {@link MutableSmtpSession}).
	 */
	readonly secure: boolean;
	/**
	 * Whether AUTH has succeeded on this connection. `readonly` in the public
	 * type so a handler cannot forge an authenticated session.
	 */
	readonly authenticated: boolean;
	/** Authenticated user identity, set by a successful AUTH. Read-only to handlers. */
	readonly user?: string;
	/** Argument of the last HELO/EHLO, if any. */
	clientHostname?: string;
	/** Whether the peer greeted with EHLO (ESMTP) vs HELO. */
	esmtp: boolean;
	/** Current envelope sender, set by a successful MAIL FROM. */
	mailFrom?: SmtpAddress;
	/** Current envelope recipients, appended by successful RCPT TO. */
	rcptTo: SmtpAddress[];
	/** Caller session state. */
	state: S;
	/** Caller per-transaction state. */
	transaction?: T;
}

/**
 * Internal mutable view of {@link SmtpSession}. The command loop and auth module
 * flip `secure` / `authenticated` / `user` through this view; the public
 * {@link SmtpSession} keeps those fields `readonly` so a handler cannot forge
 * the security posture. NOT part of the package's public API (not re-exported
 * from `index.ts`).
 */
export interface MutableSmtpSession<S = unknown, T = unknown> extends Omit<
	SmtpSession<S, T>,
	'secure' | 'authenticated' | 'user'
> {
	secure: boolean;
	authenticated: boolean;
	user?: string;
}

/**
 * A handler may return a {@link SmtpReply} to override the default response, or
 * return nothing to accept with the loop's default. To reject, either return a
 * reply with a 4xx/5xx code or throw {@link SmtpReplyError}.
 */
export type SmtpHandlerResult = SmtpReply | void;

/** Server-side SMTP timeouts (RFC 5321 §4.5.3.2), in milliseconds. */
export interface SmtpTimeouts {
	/** Idle time allowed while waiting for the next command. Default 300_000. */
	commandMs: number;
	/** Idle time allowed while receiving DATA content. Default 600_000. */
	dataMs: number;
}

/** Options for {@link createSmtpListener}. */
export interface SmtpListenerOptions<S = unknown, T = unknown> {
	/** Hostname announced in the 220 banner and EHLO greeting. */
	hostname: string;
	/** Banner text after the 220 code. Defaults to `${hostname} ESMTP`. */
	banner?: string;
	/** EHLO capability lines (without SIZE, which is derived). Default []. */
	extensions?: string[];
	/** Hard byte budget for buffered DATA (advertised via SIZE + enforced). */
	maxMessageBytes?: number;
	/**
	 * Multiple of `maxMessageBytes` past which the socket is destroyed outright
	 * rather than merely refused (bandwidth bound). Default 4 — matches
	 * `apps/mta/src/lib/dataStream.ts`.
	 */
	abortFactor?: number;
	/** Max bytes in a single command line before the peer is dropped. Default 4096. */
	maxCommandBytes?: number;
	/** Consecutive unrecognized/erroring commands tolerated before 421 + close. Default 25. */
	maxBadCommands?: number;
	timeouts?: Partial<SmtpTimeouts>;
	/**
	 * TLS material. When present the listener advertises STARTTLS and upgrades on
	 * demand (RFC 3207). Required when {@link implicitTls} is set.
	 */
	tls?: SmtpTlsConfig;
	/**
	 * Wrap the whole connection in TLS from the first byte (implicit TLS, e.g.
	 * port 465 — RFC 8314). Requires {@link tls}. When set, STARTTLS is not
	 * advertised and the session starts `secure`.
	 */
	implicitTls?: boolean;
	/** SASL AUTH configuration. When present the listener advertises + accepts AUTH. */
	auth?: SmtpAuthConfig<S, T>;
	/** Build caller session state for a new connection. */
	createSession?: (base: SmtpSession<S, T>) => S;
	/** Called after the banner is sent. */
	onConnect?: (session: SmtpSession<S, T>) => Promise<SmtpHandlerResult> | SmtpHandlerResult;
	/** Called on HELO/EHLO with the announced client hostname. */
	onHelo?: (
		hostname: string,
		session: SmtpSession<S, T>
	) => Promise<SmtpHandlerResult> | SmtpHandlerResult;
	/** Called on MAIL FROM. Return/throw to reject; otherwise the sender is accepted. */
	onMailFrom?: (
		address: SmtpAddress,
		session: SmtpSession<S, T>
	) => Promise<SmtpHandlerResult> | SmtpHandlerResult;
	/** Called on RCPT TO. Return/throw to reject; otherwise the recipient is accepted. */
	onRcptTo?: (
		address: SmtpAddress,
		session: SmtpSession<S, T>
	) => Promise<SmtpHandlerResult> | SmtpHandlerResult;
	/** Called with the fully-received, dot-decoded message after DATA. */
	onData?: (
		message: Buffer,
		session: SmtpSession<S, T>
	) => Promise<SmtpHandlerResult> | SmtpHandlerResult;
	/** Optional structured error sink. */
	onError?: (err: Error) => void;
}
