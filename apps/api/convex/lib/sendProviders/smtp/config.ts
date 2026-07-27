'use node';

/**
 * SMTP-relay CLIENT CONFIG — how to reach one configured relay instance.
 *
 * Split out of `./index.ts` (the send path) so the connection/TLS/AUTH
 * decisions, which are per-TRANSPORT and cached across sends, sit apart from
 * the per-MESSAGE send. Re-exported by `./index.ts`, so the adapter's public
 * surface is unchanged.
 */

import os from 'node:os';
import type { SmtpConnectOptions, AuthConfig } from '@owlat/smtp-client';
import { getOptional } from '../../env';
import { transportEnvBoolean, transportEnvOptional, transportEnvRequired } from '../transportEnv';
import { sendTransportEnvName, type SendTransportRecord } from '../transports';

/** Default submission port when `SMTP_RELAY_PORT` is unset (STARTTLS on 587). */
const DEFAULT_SMTP_PORT = 587;

/**
 * Bound the pre-acceptance phase (TCP connect + server greeting) well under
 * `SMTP_SEND_TIMEOUT_MS` so an unreachable relay fails in a pre-wire phase
 * (`connect`/`greeting`) — which is retryable (nothing reached the wire) —
 * rather than tripping the ambiguous outer `withTimeout` that has to be treated
 * as terminal.
 */
const SMTP_CONNECTION_TIMEOUT_MS = 15_000;

/** Resolved, non-secret relay client config: how to connect + how to AUTH. */
export interface RelayClientConfig {
	connect: SmtpConnectOptions;
	auth: AuthConfig;
}

// One resolved config per CONFIGURED TRANSPORT, not one per deployment: two
// `smtp` transports point at different relays with different credentials, so a
// single cached config would send the second instance's mail through the first
// instance's relay.
const cachedConfigs = new Map<string, RelayClientConfig>();

/** Resolved, non-secret relay client inputs (env-derived). */
export interface RelayClientInput {
	host: string;
	port: number;
	/** true ⇒ implicit TLS (465); false ⇒ STARTTLS upgrade (587). */
	secure: boolean;
	user: string;
	pass: string;
	/** EHLO identity announced to the relay. */
	ehloName: string;
}

/**
 * Assemble the in-house SMTP-client config for a relay send. Pure and exported
 * so the TLS floor and STARTTLS-enforcement invariants are pinned by a test
 * rather than living only inside the network path.
 *
 * - `requireTls: !secure` — on the STARTTLS path demand the upgrade so a relay
 *   that omits STARTTLS (or a MITM stripping it) can't silently downgrade the
 *   AUTH credentials + body to cleartext; the client fails closed
 *   (`starttls-unavailable`) instead of proceeding cleartext. `implicit` is TLS
 *   from byte zero and trivially satisfies the floor.
 * - `tls.minVersion: 'TLSv1.2'` — pin the floor (RFC 8996 deprecates TLS 1.0/1.1,
 *   RFC 9325 mandates 1.2+). The direct-MX pool already pins this; without it the
 *   relay path's floor was Node's env-fragile process default.
 * - the connect/greeting timeout is bounded so an unreachable relay fails in a
 *   pre-wire phase (retryable) rather than tripping the ambiguous outer timeout.
 */
export function buildRelayClientConfig(input: RelayClientInput): RelayClientConfig {
	return {
		connect: {
			host: input.host,
			port: input.port,
			ehloName: input.ehloName,
			tlsMode: input.secure ? 'implicit' : 'starttls',
			// Fail closed if the STARTTLS relay omits the upgrade — credentials + body
			// must never reach a cleartext channel.
			requireTls: !input.secure,
			tls: { minVersion: 'TLSv1.2' as const },
			// Fail a merely-unreachable relay fast and retryably (see the constant).
			timeouts: {
				connect: SMTP_CONNECTION_TIMEOUT_MS,
				greeting: SMTP_CONNECTION_TIMEOUT_MS,
			},
		},
		auth: {
			credentials: { username: input.user, password: input.pass },
		},
	};
}

/**
 * The name announced in EHLO to the relay when `EHLO_HOSTNAME` is unset. A bare
 * `os.hostname()` is a dotless hex token in a container, which strict relays
 * reject (`reject_non_fqdn_helo_hostname`), so fall back to the RFC 5321 §4.1.3
 * address literal `[127.0.0.1]` when the hostname is not an FQDN, and bracket a
 * bare IPv4 hostname. This mirrors mail-sync's `ehloName()` and the old
 * nodemailer `_getHostname()` fallback the outbound path preserved.
 */
export function relayEhloName(): string {
	let host: string;
	try {
		host = os.hostname() || '';
	} catch {
		host = '';
	}
	if (host === '' || !host.includes('.')) {
		return '[127.0.0.1]';
	}
	if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
		return `[${host}]`;
	}
	return host;
}

/**
 * Resolve (once per transport) the relay client config for ONE configured
 * `smtp` transport. `SMTP_RELAY_SECURE=true` opens an implicit-TLS connection
 * (typically 465); unset/false connects cleartext and upgrades via STARTTLS
 * (587). Auth credentials are required — this deployment authenticates to the
 * relay. A named instance reads the same variables under its `__<KEY>` suffix.
 */
export function getClientConfig(transport: SendTransportRecord): RelayClientConfig {
	const cached = cachedConfigs.get(transport.id);
	if (cached) return cached;
	const host = transportEnvRequired(transport, 'SMTP_RELAY_HOST');
	const portRaw = transportEnvOptional(transport, 'SMTP_RELAY_PORT');
	const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_SMTP_PORT;
	if (!Number.isFinite(port) || port <= 0) {
		throw new Error(
			`Invalid ${sendTransportEnvName('SMTP_RELAY_PORT', transport.instanceKey)}: ${portRaw}`
		);
	}
	const secure = transportEnvBoolean(transport, 'SMTP_RELAY_SECURE');
	const config = buildRelayClientConfig({
		host,
		port,
		secure,
		user: transportEnvRequired(transport, 'SMTP_RELAY_USERNAME'),
		pass: transportEnvRequired(transport, 'SMTP_RELAY_PASSWORD'),
		ehloName: getOptional('EHLO_HOSTNAME') ?? relayEhloName(),
	});
	cachedConfigs.set(transport.id, config);
	return config;
}

/** Clears the per-transport relay config cache. Tests only. */
export function _resetSmtpConfigCacheForTests(): void {
	cachedConfigs.clear();
}
