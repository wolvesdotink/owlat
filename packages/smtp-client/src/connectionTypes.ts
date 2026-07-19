/**
 * Shared option types and defaults for the connection engine.
 *
 * Split out from `connection.ts` so the socket layer (`transport.ts`) and the
 * `SmtpConnection` orchestrator (`connection.ts`) can both name the same option
 * shapes without a runtime import cycle (these are type-only) and so no single
 * file exceeds the size ratchet.
 */

import type tls from 'node:tls';
import type { PeerCertificate } from 'node:tls';

/** Default TLS floor. TLS 1.0/1.1 are deprecated; we never negotiate below 1.2. */
export const DEFAULT_MIN_TLS_VERSION: tls.SecureVersion = 'TLSv1.2';

/** Per-phase timeouts (milliseconds). Any omitted phase inherits the default. */
export interface SmtpTimeouts {
	/** TCP connect (and, for implicit TLS, the handshake). */
	connect: number;
	/** Waiting for the server's opening greeting. */
	greeting: number;
	/** Waiting for the reply to a single command (EHLO, STARTTLS, …). */
	command: number;
	/** Waiting for the reply that acknowledges the message body. */
	data: number;
}

export const DEFAULT_TIMEOUTS: SmtpTimeouts = {
	connect: 30_000,
	greeting: 30_000,
	command: 30_000,
	data: 600_000,
};

/**
 * TLS parameters for the secured leg of a connection. `servername` drives SNI
 * (RFC 6066 §3) and hostname verification; `rejectUnauthorized` gates whether a
 * verification failure aborts the handshake (opportunistic TLS sets it false).
 * `ca` and `checkServerIdentity` are passthroughs for pinned / DANE callers.
 */
export interface SmtpTlsOptions {
	/** SNI + identity-check name. Defaults to the connection `host`. */
	servername?: string;
	/** Abort the handshake on a verification failure. Default `true`. */
	rejectUnauthorized?: boolean;
	/** Minimum negotiated protocol. Default {@link DEFAULT_MIN_TLS_VERSION}. */
	minVersion?: tls.SecureVersion;
	/** Extra trust anchors, for pinned / private-CA verification. */
	ca?: string | Buffer | Array<string | Buffer>;
	/** Custom identity check (e.g. DANE). Return an `Error` to reject. */
	checkServerIdentity?: (servername: string, cert: PeerCertificate) => Error | undefined;
	/**
	 * Post-handshake certificate authenticator, run on the freshly-secured socket
	 * BEFORE the (re-)EHLO resumes. Unlike {@link checkServerIdentity} — which Node
	 * invokes only when `rejectUnauthorized` is true — this ALWAYS runs, so it can
	 * authenticate a certificate the WebPKI path deliberately ignores (RFC 7672
	 * DANE-EE, where `rejectUnauthorized` is false). A returned `Error` destroys the
	 * socket and fails the connection closed with `tlsCause: 'handshake'` — no
	 * cleartext fallback, no SMTP resumed over an unauthenticated channel.
	 */
	verifyPeerCertificate?: (socket: tls.TLSSocket) => Error | undefined;
}

/** How the connection reaches TLS (or stays cleartext). */
export type SmtpTlsMode = 'implicit' | 'starttls' | 'none';

export interface SmtpConnectOptions {
	/** Remote host (an IP or a hostname). */
	host: string;
	/** Remote port. */
	port: number;
	/** The name announced in EHLO/HELO (the sending MTA's identity). */
	ehloName: string;
	/**
	 * `implicit` — TLS from byte zero (465). `starttls` — cleartext then an
	 * in-band upgrade (25/587). `none` — cleartext, never upgraded (loopback).
	 */
	tlsMode: SmtpTlsMode;
	/**
	 * Require the connection to reach TLS. For `starttls`: if the server does not
	 * advertise STARTTLS, connect() fails closed (`starttls-unavailable`) instead
	 * of proceeding in cleartext. `implicit` is TLS from byte zero and trivially
	 * satisfies the floor. Combining it with `none` is a contradiction — a
	 * cleartext connection cannot satisfy a required floor — so connect() fails
	 * closed in phase `connect` rather than silently proceeding in cleartext.
	 */
	requireTls?: boolean;
	/** Source address to bind the outgoing socket to (per-IP egress). */
	localAddress?: string;
	/** TLS parameters for the secured leg. */
	tls?: SmtpTlsOptions;
	/** Per-phase timeout overrides. */
	timeouts?: Partial<SmtpTimeouts>;
}
