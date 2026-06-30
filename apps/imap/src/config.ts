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

function readPemEnv(envName: string, fileEnvName: string): string | null {
	const inline = process.env[envName];
	if (inline) return inline;
	const path = process.env[fileEnvName];
	if (path && existsSync(path)) return readFileSync(path, 'utf-8');
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
				cert: readFileSync(defaultCert, 'utf-8'),
				key: readFileSync(defaultKey, 'utf-8'),
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
