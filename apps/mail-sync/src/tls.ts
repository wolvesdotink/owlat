/**
 * TLS enforcement for outbound SMTP / IMAP to a user's external mailbox.
 *
 * `secure: false` does NOT mean "plaintext" — for submission/IMAP ports (587/143)
 * it is the standard STARTTLS configuration (iCloud, Outlook.com, many others).
 * We must therefore guarantee the wire is encrypted regardless of whether the
 * server uses implicit TLS or STARTTLS: for any non-loopback host we force a
 * STARTTLS-before-auth upgrade (smtp-client `requireTls`, imapflow `doSTARTTLS`),
 * so the connection FAILS rather than send the mailbox password in the clear.
 * Plaintext is allowed only to a loopback host (a local Proton Bridge / relay).
 */

import type { SmtpTlsMode } from '@owlat/smtp-client';

/**
 * True when `host` is a loopback address — the only host for which an
 * unencrypted IMAP/SMTP connection is permitted. Mirrors isLocalMailHost in the
 * Convex backend (apps/api/convex/lib/mailHost.ts), which gates what the worker
 * is ever handed.
 */
export function isLoopbackHost(host: string): boolean {
	let h = host.trim().toLowerCase();
	if (h === '') return false;
	if (h.endsWith('.')) h = h.slice(0, -1);
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
	if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
	if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
	return false;
}

/**
 * The lowest TLS version we are willing to negotiate with a remote mail server.
 * TLS 1.0/1.1 are deprecated (RFC 8996); pinning the floor at 1.2 stops a
 * downgrade to a broken protocol from silently succeeding. Only pinned for
 * non-loopback hosts — a loopback relay (Proton Bridge) may speak plaintext.
 */
const MIN_TLS_VERSION = 'TLSv1.2' as const;

/**
 * The TLS-bearing subset of an `@owlat/smtp-client` connect option set: the
 * negotiation shape (`tlsMode`), the fail-closed floor flag (`requireTls`), and
 * the secured-leg TLS parameters. `smtpTlsOptions` returns exactly this so the
 * send / verify call sites merge it with `host` / `port` / `ehloName`.
 */
export interface SmtpClientTlsOptions {
	tlsMode: SmtpTlsMode;
	requireTls: boolean;
	tls?: { minVersion: typeof MIN_TLS_VERSION };
}

/**
 * `@owlat/smtp-client` connect TLS options. For a non-loopback host the wire MUST
 * be encrypted: `secure` picks implicit TLS (465) vs. a forced STARTTLS upgrade
 * (587/25), and `requireTls: true` makes the client fail closed rather than send
 * credentials over cleartext if STARTTLS is not offered. The TLS floor is pinned
 * at 1.2; certificate verification is left at the client's secure default
 * (`rejectUnauthorized` is never set to false). For a loopback relay (Proton
 * Bridge) TLS is not forced: an insecure loopback port uses opportunistic
 * STARTTLS (`tlsMode: 'starttls'` + `requireTls: false`) — it upgrades when the
 * relay advertises STARTTLS and stays cleartext only when it does not, exactly as
 * the previous library's `{ secure: false, requireTLS: false }` config did — and
 * a loopback host that asked for a secure port still gets implicit TLS.
 */
export function smtpTlsOptions(host: string, secure: boolean): SmtpClientTlsOptions {
	if (isLoopbackHost(host)) {
		return { tlsMode: secure ? 'implicit' : 'starttls', requireTls: false };
	}
	return {
		tlsMode: secure ? 'implicit' : 'starttls',
		requireTls: true,
		tls: { minVersion: MIN_TLS_VERSION },
	};
}

/**
 * imapflow connect TLS options. `doSTARTTLS: true` upgrades to TLS before auth
 * and fails if the server doesn't support it. It is INVALID to combine with
 * `secure: true`, so it is only set for a non-secure connection to a remote host.
 * For a non-loopback host the TLS floor is pinned at 1.2; certificate
 * verification is left at imapflow's secure default (`tls.rejectUnauthorized` is
 * never set to false).
 */
export function imapTlsOptions(
	host: string,
	secure: boolean
): { secure: boolean; doSTARTTLS?: true; tls?: { minVersion: typeof MIN_TLS_VERSION } } {
	if (isLoopbackHost(host)) return { secure };
	if (!secure) return { secure, doSTARTTLS: true, tls: { minVersion: MIN_TLS_VERSION } };
	return { secure, tls: { minVersion: MIN_TLS_VERSION } };
}
