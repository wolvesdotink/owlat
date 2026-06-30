/**
 * TLS enforcement for outbound SMTP / IMAP to a user's external mailbox.
 *
 * `secure: false` does NOT mean "plaintext" — for submission/IMAP ports (587/143)
 * it is the standard STARTTLS configuration (iCloud, Outlook.com, many others).
 * We must therefore guarantee the wire is encrypted regardless of whether the
 * server uses implicit TLS or STARTTLS: for any non-loopback host we force a
 * STARTTLS-before-auth upgrade (nodemailer `requireTLS`, imapflow `doSTARTTLS`),
 * so the connection FAILS rather than send the mailbox password in the clear.
 * Plaintext is allowed only to a loopback host (a local Proton Bridge / relay).
 */

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
 * nodemailer transport TLS options. `requireTLS` forces a STARTTLS upgrade on a
 * non-secure connection and aborts the send if it cannot be encrypted. Harmless
 * when `secure: true` (already implicit TLS). For a non-loopback host we also pin
 * the TLS floor at 1.2; certificate verification is left at nodemailer's secure
 * default (`tls.rejectUnauthorized` is never set to false). Disabled only for
 * loopback.
 */
export function smtpTlsOptions(
	host: string,
	secure: boolean,
): { secure: boolean; requireTLS: boolean; tls?: { minVersion: typeof MIN_TLS_VERSION } } {
	if (isLoopbackHost(host)) return { secure, requireTLS: false };
	return { secure, requireTLS: true, tls: { minVersion: MIN_TLS_VERSION } };
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
	secure: boolean,
): { secure: boolean; doSTARTTLS?: true; tls?: { minVersion: typeof MIN_TLS_VERSION } } {
	if (isLoopbackHost(host)) return { secure };
	if (!secure) return { secure, doSTARTTLS: true, tls: { minVersion: MIN_TLS_VERSION } };
	return { secure, tls: { minVersion: MIN_TLS_VERSION } };
}
