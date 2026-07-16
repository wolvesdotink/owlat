/**
 * TLS material and the STARTTLS / implicit-TLS transport upgrade (RFC 3207,
 * RFC 8314).
 *
 * The cipher policy is copied VERBATIM from today's submission listeners
 * (`apps/mta/src/smtp/submissionServer.ts`): a TLSv1.2 floor, an AEAD-only
 * ECDHE cipher list, `honorCipherOrder`, and optional SNI. Both flavors — the
 * STARTTLS upgrade of a live plaintext socket and an implicit-TLS listener that
 * is encrypted from the first byte — present the same secure context, so the
 * two transports are cryptographically indistinguishable (D6).
 */

import {
	createSecureContext,
	TLSSocket,
	type SecureContext,
	type SecureContextOptions,
	type SecureVersion,
	type TlsOptions,
} from 'node:tls';
import type { Socket } from 'node:net';

/**
 * The exact AEAD-only ECDHE suite the 587/465 listeners advertise today. Kept
 * as a single joined string so the wire policy is auditable in one spot and
 * stays byte-identical to `submissionServer.ts` across the cutover.
 */
export const DEFAULT_SMTP_CIPHERS: string = [
	'ECDHE-ECDSA-AES128-GCM-SHA256',
	'ECDHE-RSA-AES128-GCM-SHA256',
	'ECDHE-ECDSA-AES256-GCM-SHA384',
	'ECDHE-RSA-AES256-GCM-SHA384',
	'ECDHE-ECDSA-CHACHA20-POLY1305',
	'ECDHE-RSA-CHACHA20-POLY1305',
].join(':');

/** SNI resolver, mirroring node's `tls` `SNICallback` shape. */
export type SmtpSniCallback = (
	servername: string,
	cb: (err: Error | null, ctx?: SecureContext) => void
) => void;

/**
 * Caller-facing TLS configuration. `cert`/`key` are required; the cipher floor,
 * suite list and `honorCipherOrder` default to today's hardened policy so a
 * caller only has to supply key material to get the exact production posture.
 */
export interface SmtpTlsConfig {
	cert: string | Buffer;
	key: string | Buffer;
	/** TLS floor. Default `'TLSv1.2'` (RFC 8314 §4.1). */
	minVersion?: SecureVersion;
	/** OpenSSL cipher string. Default {@link DEFAULT_SMTP_CIPHERS}. */
	ciphers?: string;
	/** Prefer the server's cipher order. Default `true`. */
	honorCipherOrder?: boolean;
	/** Optional SNI resolver for multi-cert deployments. */
	SNICallback?: SmtpSniCallback;
}

/**
 * TLS config with defaults applied once, at listen time. `options` feeds an
 * implicit-TLS `tls.createServer`; `secureContext` is reused for every STARTTLS
 * upgrade so contexts are not rebuilt per connection.
 */
export interface ResolvedTlsConfig {
	readonly options: TlsOptions;
	readonly secureContext: SecureContext;
	readonly SNICallback?: SmtpSniCallback;
}

/** Apply the hardened defaults and precompute the secure context. */
export function resolveTlsConfig(cfg: SmtpTlsConfig): ResolvedTlsConfig {
	const contextOptions: SecureContextOptions = {
		cert: cfg.cert,
		key: cfg.key,
		minVersion: cfg.minVersion ?? 'TLSv1.2',
		ciphers: cfg.ciphers ?? DEFAULT_SMTP_CIPHERS,
		honorCipherOrder: cfg.honorCipherOrder ?? true,
	};
	// Build the optional SNI property ONCE and reuse it for both the
	// implicit-TLS `tls.createServer` options and the resolved config's single
	// source of truth (read by `upgradeTls` for the STARTTLS path).
	const sniOption = cfg.SNICallback ? { SNICallback: cfg.SNICallback } : {};
	const options: TlsOptions = { ...contextOptions, ...sniOption };
	return {
		options,
		secureContext: createSecureContext(contextOptions),
		...sniOption,
	};
}

/**
 * Upgrade a live plaintext socket to TLS in response to STARTTLS (RFC 3207).
 * Resolves with the negotiated {@link TLSSocket} once the handshake completes;
 * rejects if the handshake errors OR the peer closes the socket before it
 * completes. The caller MUST perform a full SMTP state reset and re-read only
 * from the returned socket — any bytes buffered on the plaintext socket are
 * discarded by constructing a fresh reader, so a plaintext-injection race cannot
 * survive the upgrade.
 *
 * The `'close'` rejection is load-bearing against a hostile peer: a client that
 * sends STARTTLS, reads the `220`, then FINs (or goes silent) fires NEITHER
 * `'secure'` NOR `'error'` — without settling on `'close'` the returned promise
 * would never resolve, leaving the command loop suspended and the FD + session
 * pinned until the idle timer expires (~5 min per connection under a
 * connect→STARTTLS→FIN flood). This mirrors `smtp-server`, which registers
 * `secureSocket.once('close', ...)` and synthesizes "Socket closed while
 * initiating TLS" (`smtp-connection.js`).
 */
export function upgradeTls(socket: Socket, resolved: ResolvedTlsConfig): Promise<TLSSocket> {
	return new Promise<TLSSocket>((resolve, reject) => {
		const tlsSocket = new TLSSocket(socket, {
			isServer: true,
			secureContext: resolved.secureContext,
			...(resolved.SNICallback ? { SNICallback: resolved.SNICallback } : {}),
		});
		const cleanup = (): void => {
			tlsSocket.removeListener('secure', onSecure);
			tlsSocket.removeListener('error', onError);
			tlsSocket.removeListener('close', onClose);
		};
		const onSecure = (): void => {
			cleanup();
			resolve(tlsSocket);
		};
		const onError = (err: Error): void => {
			cleanup();
			reject(err);
		};
		const onClose = (): void => {
			cleanup();
			reject(new Error('Socket closed while initiating TLS'));
		};
		tlsSocket.once('secure', onSecure);
		tlsSocket.once('error', onError);
		tlsSocket.once('close', onClose);
	});
}
