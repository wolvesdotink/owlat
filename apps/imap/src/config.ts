import { hostname } from 'os';
import { readIntEnv, TCP_PORT_RANGE, TIMER_DELAY_MS_RANGE } from '@owlat/shared/nodeEnv';
import { loadTlsMaterial, type TlsMaterial } from '@owlat/shared/tlsMaterial';
import {
	MAIL_AUTH_FAILURE_WINDOW_MS,
	MAIL_AUTH_FAILURES_PER_ADDRESS,
} from '@owlat/shared/mailAuthPolicy';

export interface ImapConfig {
	port: number;
	listenAddress: string;
	/**
	 * `paths` is set when both halves were read from files, so the server can
	 * re-read them after a renewal (tlsReload.ts). Inline PEM has none.
	 */
	tls: TlsMaterial | null;
	greetingHost: string;
	convexUrl: string;
	convexAdminKey: string;
	redisUrl: string | null;
	maxConnectionsPerIp: number;
	maxClients: number;
	idleTimeoutMs: number;
	/**
	 * Max length (chars) of a single un-terminated command line before the pump
	 * aborts the connection. Bounds pre-auth memory/CPU: without it a client that
	 * never sends CRLF grows the read buffer without limit. Default 64 KiB.
	 */
	maxLineBytes?: number;
	/**
	 * Max declared size (bytes) of an IMAP `{N}` literal (e.g. an APPEND body).
	 * Bounds post-auth memory and unmetered storage. Default 50 MiB.
	 */
	maxLiteralBytes?: number;
	/**
	 * Grace period (ms) for an accepted connection to complete LOGIN before the
	 * pump drops it. Stops unauthenticated sockets from squatting global slots
	 * (slowloris / connection-slot exhaustion). Default 30 s.
	 */
	preAuthDeadlineMs?: number;
	authRateLimit: { failuresPerWindow: number; windowMs: number; tarpitMs: number };
}

/**
 * Explicit, out-loud opt-out from the LOGIN brute-force limiter.
 *
 * Exact-match `true` only: a typo, an empty string, or a stray `0` must read as
 * "no", because the failure direction of this switch is an internet-facing auth
 * port with unlimited password guessing.
 */
function allowsUnthrottledAuth(): boolean {
	return process.env['IMAP_ALLOW_UNTHROTTLED_AUTH'] === 'true';
}

export function loadConfig(): ImapConfig {
	const port = readIntEnv(process.env, 'IMAP_PORT', { default: 993, ...TCP_PORT_RANGE });
	const listenAddress = process.env['IMAP_LISTEN'] ?? '0.0.0.0';
	const greetingHost = process.env['IMAP_GREETING_HOST'] ?? hostname();
	const convexUrl = process.env['CONVEX_URL'] ?? '';
	const convexAdminKey = process.env['CONVEX_ADMIN_KEY'] ?? '';
	const redisUrl = process.env['REDIS_URL'] ?? null;

	if (!convexUrl) throw new Error('CONVEX_URL is required');
	if (!convexAdminKey) throw new Error('CONVEX_ADMIN_KEY is required');

	// Port 993 faces the internet and LOGIN is the only thing between it and a
	// user's mail, so the brute-force limiter (rateLimit.ts) is not optional in
	// production. A missing REDIS_URL is a MISCONFIGURATION, not a degraded mode:
	// it is silent, permanent, and applies to 100% of authentication attempts —
	// and it shipped in every release because the only symptom was one level-40
	// log line at boot that nobody reads. Refuse it, exactly like the missing-TLS
	// guard in server.ts, which is gated the same way so `bun dev` keeps working.
	//
	// Deliberately NOT the same call as a Redis that is configured but unhealthy:
	// that outage is transient and loud, and locking every user out of their mail
	// because the cache blinked is the worse failure — so the request path stays
	// fail-open (see AuthRateLimiter). This guard is only about never again
	// running an internet-facing auth port with no limiter configured at all.
	// An operator who really wants that must opt out in so many words.
	if (!redisUrl && !allowsUnthrottledAuth() && process.env['NODE_ENV'] === 'production') {
		throw new Error(
			'IMAP refusing to start in production without REDIS_URL: it backs the LOGIN ' +
				'brute-force limiter, and port 993 is internet-facing. Set REDIS_URL ' +
				'(docker-compose.yml wires it for you), or set IMAP_ALLOW_UNTHROTTLED_AUTH=true ' +
				'to accept unlimited password guessing.'
		);
	}

	// Same loader and fail-loud rules as the MTA's port-25 listener, which reads
	// the same mail-certs volume: half a pair or a missing explicit file stops
	// the boot. The volume is mounted at /opt/owlat/certs by default.
	const tls: ImapConfig['tls'] = loadTlsMaterial({
		inlineCert: 'IMAP_TLS_CERT',
		inlineKey: 'IMAP_TLS_KEY',
		certFile: 'IMAP_TLS_CERT_FILE',
		keyFile: 'IMAP_TLS_KEY_FILE',
		certDir: process.env['TLS_CERT_DIR'] ?? '/opt/owlat/certs',
		label: 'IMAP',
		ownershipHint:
			'The IMAP container mounts the cert volume read-only, so it cannot fix this itself ' +
			'(on the VPS the acme sidecar writes it: infra/templates/acme-entrypoint.sh).',
	});

	return {
		port,
		listenAddress,
		tls,
		greetingHost,
		convexUrl,
		convexAdminKey,
		redisUrl,
		maxConnectionsPerIp: readIntEnv(process.env, 'IMAP_MAX_CONN_PER_IP', { default: 20, min: 1 }),
		maxClients: readIntEnv(process.env, 'IMAP_MAX_CLIENTS', { default: 500, min: 1 }),
		// IMAP IDLE clients are expected to issue a NOOP / re-IDLE every
		// 29 minutes (RFC 2177). We close idle channels at 30 min.
		idleTimeoutMs: readIntEnv(process.env, 'IMAP_IDLE_TIMEOUT_MS', {
			default: 30 * 60 * 1000,
			...TIMER_DELAY_MS_RANGE,
		}),
		maxLineBytes: readIntEnv(process.env, 'IMAP_MAX_LINE_BYTES', { default: 64 * 1024, min: 1 }),
		maxLiteralBytes: readIntEnv(process.env, 'IMAP_MAX_LITERAL_BYTES', {
			default: 50 * 1024 * 1024,
			min: 1,
		}),
		preAuthDeadlineMs: readIntEnv(process.env, 'IMAP_PRE_AUTH_DEADLINE_MS', {
			default: 30 * 1000,
			...TIMER_DELAY_MS_RANGE,
		}),
		authRateLimit: {
			failuresPerWindow: MAIL_AUTH_FAILURES_PER_ADDRESS,
			windowMs: MAIL_AUTH_FAILURE_WINDOW_MS,
			tarpitMs: 15 * 60 * 1000,
		},
	};
}
