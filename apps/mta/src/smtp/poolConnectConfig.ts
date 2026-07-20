/**
 * Connect-config domain for the SMTP connection pool: the acquire-time OPTIONS
 * shape, the pool KEY partitioning (mx/bindIp/dkim/tls-profile), and the
 * @owlat/smtp-client connect config the pool hands to each delivery. Split out of
 * connectionPool.ts so that file stays focused on the entry lifecycle + live-
 * socket reuse; behaviour here is byte-identical to the previous static methods.
 */

import type { TLSSocket } from 'node:tls';
import type { SmtpConnectOptions } from '@owlat/smtp-client';

export interface AcquireOptions {
	port?: number;
	requireTLS?: boolean;
	tls?: {
		rejectUnauthorized?: boolean;
		minVersion?: 'TLSv1.2' | 'TLSv1.3';
		/**
		 * RFC 6066 §3 Server Name Indication. Offered in the TLS ClientHello so a
		 * shared-hosting MX can select the right certificate. Forwarded verbatim to
		 * the client's TLS options; when omitted the client defaults it to `host`.
		 */
		servername?: string;
		/**
		 * Runs after STARTTLS succeeds but before SMTP resumes. It runs even with
		 * PKIX rejection disabled (DANE-EE), and any returned error destroys the
		 * socket before the post-TLS EHLO.
		 */
		verifyPeerCertificate?: (socket: TLSSocket) => Error | undefined;
		/** Pool-only identity for the exact TLSA RRset and DANE-TA reference names. */
		danePolicyFingerprint?: string;
	};
	/** The EHLO/HELO name announced to the MX (the sending MTA identity). */
	name?: string;
	connectionTimeout?: number;
	greetingTimeout?: number;
	socketTimeout?: number;
	/** The DKIM sending domain — a KEY PARTITIONING DIMENSION ONLY (signing is sign-time). */
	dkimDomain?: string;
}

/** The TLS-strictness dimensions that participate in a pool key's identity. */
export interface TlsKeyProfile {
	requireTLS?: boolean;
	rejectUnauthorized?: boolean;
	danePolicyFingerprint?: string;
}

/**
 * Build the pool key for a given connection.
 *
 * The TLS profile (requireTLS + rejectUnauthorized + DANE policy) is part of the
 * key so a verifying/enforcing connection is NEVER served an opportunistic,
 * non-verifying entry to the same shared MX. Defaults match the config-factory
 * defaults (requireTLS=false, rejectUnauthorized=false) so callers that omit the
 * profile get the opportunistic bucket — the existing behaviour.
 */
export function buildPoolKey(
	mxHost: string,
	bindIp: string,
	dkimDomain?: string,
	tls?: TlsKeyProfile
): string {
	const requireTLS = tls?.requireTLS ?? false;
	const rejectUnauthorized = tls?.rejectUnauthorized ?? false;
	// A DANE entry must not outlive or cross recipient-specific TLSA policy. The
	// exact RRset + reference-name fingerprint therefore participates in identity;
	// non-DANE keys remain unchanged.
	const daneSuffix = tls?.danePolicyFingerprint ? `da${tls.danePolicyFingerprint}` : '';
	const tlsProfile = `rt${requireTLS ? 1 : 0}ru${rejectUnauthorized ? 1 : 0}${daneSuffix}`;
	return `${mxHost}:${bindIp}:${dkimDomain ?? 'none'}:${tlsProfile}`;
}

/**
 * Assemble the @owlat/smtp-client connect config for one MX/bindIp/profile.
 *
 * Outbound MX delivery is always STARTTLS on port 25 (opportunistic upgrade,
 * escalated to a required floor by `requireTLS`). The TLSv1.2 floor is pinned here
 * (RFC 8996/9325) so it never rests on Node's env-fragile process default; the
 * caller may raise it to TLSv1.3 but cannot lower it. `danePolicyFingerprint` is
 * pool-only identity and is deliberately NOT forwarded to the client.
 */
export function buildConnectConfig(
	mxHost: string,
	bindIp: string,
	options: AcquireOptions
): SmtpConnectOptions {
	const tls: SmtpConnectOptions['tls'] = {
		// nosemgrep -- opportunistic TLS default for SMTP delivery (RFC 7435); callers (MTA-STS enforce) override via options.tls.
		rejectUnauthorized: options.tls?.rejectUnauthorized ?? false,
		minVersion: options.tls?.minVersion ?? 'TLSv1.2',
	};
	if (options.tls?.servername !== undefined) {
		tls.servername = options.tls.servername;
	}
	if (options.tls?.verifyPeerCertificate !== undefined) {
		tls.verifyPeerCertificate = options.tls.verifyPeerCertificate;
	}
	const config: SmtpConnectOptions = {
		host: mxHost,
		port: options.port ?? 25,
		// Production always supplies `name` (the sending IP's PTR-matching FQDN). The
		// fallback must never announce the RECEIVING server's hostname (`mxHost`) —
		// that is our identity to the peer and would read as spoofing (RFC 5321
		// §4.1.1.1). Fall back to our own bind IP as an address literal (RFC 5321
		// §4.1.3), which is honest and syntactically valid. An IPv6 bind address MUST
		// carry the `IPv6:` tag (RFC 5321 §4.1.3) — a bare `[2001:db8::1]` is a syntax
		// error a strict MX may reject at EHLO.
		ehloName: options.name ?? (bindIp.includes(':') ? `[IPv6:${bindIp}]` : `[${bindIp}]`),
		tlsMode: 'starttls',
		requireTls: options.requireTLS ?? false,
		localAddress: bindIp,
		tls,
		timeouts: {
			connect: options.connectionTimeout ?? 30_000,
			greeting: options.greetingTimeout ?? 30_000,
			command: options.socketTimeout ?? 60_000,
			// Preserve the legacy socketTimeout for the whole DATA phase too. The
			// client default is intentionally much longer and would otherwise turn
			// this migration into a ten-minute stalled-send window.
			data: options.socketTimeout ?? 60_000,
		},
	};
	return config;
}
