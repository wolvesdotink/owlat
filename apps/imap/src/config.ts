import { hostname } from 'os';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ImapConfig {
	port: number;
	listenAddress: string;
	tls: { cert: string; key: string } | null;
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

/**
 * Read a PEM off disk, turning the one failure that actually happens in
 * production into an actionable message.
 *
 * `existsSync` passes and `readFileSync` throws EACCES whenever the file is
 * present but owned by another uid — which is precisely what a root-written
 * 0600 key on the shared mail-certs volume looks like to this process. The bare
 * `EACCES: permission denied, open '…/default.key'` that used to escape
 * loadConfig named no cause and no fix, and crash-looped 724 times on a live
 * instance. The volume is mounted read-only, so the repair belongs to whoever
 * wrote the file; say so.
 */
function readCertFile(path: string): string {
	try {
		return readFileSync(path, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'EACCES') {
			throw new Error(
				`Cannot read TLS material at ${path}: permission denied. The IMAP process runs ` +
					`as uid ${typeof process.getuid === 'function' ? process.getuid() : 'unknown'} and ` +
					'mounts the cert volume read-only, so it cannot fix this itself — whatever writes ' +
					'the cert must hand ownership over (docker-compose.yml: imap-cert-init chowns to ' +
					'IMAP_RUNTIME_USER; on the VPS: infra/templates/acme-entrypoint.sh).',
				{ cause: err }
			);
		}
		throw err;
	}
}

function readPemEnv(envName: string, fileEnvName: string): string | null {
	const inline = process.env[envName];
	if (inline) return inline;
	const path = process.env[fileEnvName];
	if (path && existsSync(path)) return readCertFile(path);
	return null;
}

export function loadConfig(): ImapConfig {
	const port = parseInt(process.env['IMAP_PORT'] ?? '993', 10);
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

	let tls: ImapConfig['tls'] = null;
	const cert = readPemEnv('IMAP_TLS_CERT', 'IMAP_TLS_CERT_FILE');
	const key = readPemEnv('IMAP_TLS_KEY', 'IMAP_TLS_KEY_FILE');
	if (cert && key) {
		tls = { cert, key };
	} else {
		// Look for the shared mail-certs volume mounted at /opt/owlat/certs
		const certDir = process.env['TLS_CERT_DIR'] ?? '/opt/owlat/certs';
		const defaultCert = join(certDir, 'default.crt');
		const defaultKey = join(certDir, 'default.key');
		if (existsSync(defaultCert) && existsSync(defaultKey)) {
			tls = {
				cert: readCertFile(defaultCert),
				key: readCertFile(defaultKey),
			};
		}
	}

	return {
		port,
		listenAddress,
		tls,
		greetingHost,
		convexUrl,
		convexAdminKey,
		redisUrl,
		maxConnectionsPerIp: parseInt(process.env['IMAP_MAX_CONN_PER_IP'] ?? '20', 10),
		maxClients: parseInt(process.env['IMAP_MAX_CLIENTS'] ?? '500', 10),
		// IMAP IDLE clients are expected to issue a NOOP / re-IDLE every
		// 29 minutes (RFC 2177). We close idle channels at 30 min.
		idleTimeoutMs: parseInt(process.env['IMAP_IDLE_TIMEOUT_MS'] ?? `${30 * 60 * 1000}`, 10),
		maxLineBytes: parseInt(process.env['IMAP_MAX_LINE_BYTES'] ?? `${64 * 1024}`, 10),
		maxLiteralBytes: parseInt(process.env['IMAP_MAX_LITERAL_BYTES'] ?? `${50 * 1024 * 1024}`, 10),
		preAuthDeadlineMs: parseInt(process.env['IMAP_PRE_AUTH_DEADLINE_MS'] ?? `${30 * 1000}`, 10),
		authRateLimit: {
			failuresPerWindow: 5,
			windowMs: 60_000,
			tarpitMs: 15 * 60 * 1000,
		},
	};
}
