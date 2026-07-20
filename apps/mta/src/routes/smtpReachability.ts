/**
 * Cached outbound SMTP reachability probe.
 *
 * A successful MX lookup only proves DNS works. Direct delivery also requires
 * the host to open TCP/25 from every configured sending IP, and cloud/VPS
 * providers commonly block exactly that path. This probe binds the same source
 * IP the sender uses and opens a TCP connection to a real recipient MX without
 * issuing an SMTP command or sending a message.
 */

import { resolveMx } from 'node:dns/promises';
import { createConnection } from 'node:net';

const PROBE_DOMAIN = 'gmail.com';
const PROBE_PORT = 25;
const CONNECT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

export type SmtpProbeFailureReason =
	| 'timeout'
	| 'connection_refused'
	| 'source_ip_unavailable'
	| 'network_unreachable'
	| 'connection_error';

export interface SmtpIpReachability {
	ip: string;
	status: 'ok' | 'failed';
	connectMs: number;
	reason?: SmtpProbeFailureReason;
}

export interface SmtpReachabilityResult {
	status: 'ok' | 'degraded';
	checkedAt: number;
	targetDomain: string;
	targetMx?: string;
	mxResolutionMs: number;
	ips: SmtpIpReachability[];
}

export interface SmtpReachabilityDeps {
	resolveMx: typeof resolveMx;
	connect: (args: {
		host: string;
		port: number;
		localAddress: string;
		timeoutMs: number;
	}) => Promise<void>;
	now: () => number;
}

const defaultDeps: SmtpReachabilityDeps = {
	resolveMx,
	now: Date.now,
	connect: ({ host, port, localAddress, timeoutMs }) =>
		new Promise<void>((resolve, reject) => {
			const socket = createConnection({ host, port, localAddress });
			let settled = false;
			const finish = (err?: Error & { code?: string }) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				if (err) reject(err);
				else resolve();
			};

			socket.setTimeout(timeoutMs);
			socket.once('connect', () => finish());
			socket.once('timeout', () => {
				const err = new Error('SMTP reachability probe timed out') as Error & { code?: string };
				err.code = 'ETIMEDOUT';
				finish(err);
			});
			socket.once('error', (err: Error & { code?: string }) => finish(err));
		}),
};

function failureReason(err: unknown): SmtpProbeFailureReason {
	const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
	switch (code) {
		case 'ETIMEDOUT':
			return 'timeout';
		case 'ECONNREFUSED':
			return 'connection_refused';
		case 'EADDRNOTAVAIL':
			return 'source_ip_unavailable';
		case 'ENETUNREACH':
		case 'EHOSTUNREACH':
			return 'network_unreachable';
		default:
			return 'connection_error';
	}
}

/** Run one uncached probe. Exported for deterministic unit tests. */
export async function probeSmtpReachability(
	configuredIps: string[],
	deps: SmtpReachabilityDeps = defaultDeps
): Promise<SmtpReachabilityResult> {
	const startedAt = deps.now();
	const ips = [...new Set(configuredIps)];
	let records: Awaited<ReturnType<typeof resolveMx>>;

	try {
		records = await deps.resolveMx(PROBE_DOMAIN);
	} catch {
		return {
			status: 'degraded',
			checkedAt: deps.now(),
			targetDomain: PROBE_DOMAIN,
			mxResolutionMs: deps.now() - startedAt,
			ips: ips.map((ip) => ({ ip, status: 'failed', connectMs: 0, reason: 'connection_error' })),
		};
	}

	const targetMx = [...records].sort((a, b) => a.priority - b.priority)[0]?.exchange;
	const mxResolvedAt = deps.now();
	if (!targetMx) {
		return {
			status: 'degraded',
			checkedAt: mxResolvedAt,
			targetDomain: PROBE_DOMAIN,
			mxResolutionMs: mxResolvedAt - startedAt,
			ips: ips.map((ip) => ({ ip, status: 'failed', connectMs: 0, reason: 'connection_error' })),
		};
	}

	const results = await Promise.all(
		ips.map(async (ip): Promise<SmtpIpReachability> => {
			const connectStartedAt = deps.now();
			try {
				await deps.connect({
					host: targetMx,
					port: PROBE_PORT,
					localAddress: ip,
					timeoutMs: CONNECT_TIMEOUT_MS,
				});
				return { ip, status: 'ok', connectMs: deps.now() - connectStartedAt };
			} catch (err) {
				return {
					ip,
					status: 'failed',
					connectMs: deps.now() - connectStartedAt,
					reason: failureReason(err),
				};
			}
		})
	);

	return {
		status: results.every((result) => result.status === 'ok') ? 'ok' : 'degraded',
		checkedAt: deps.now(),
		targetDomain: PROBE_DOMAIN,
		targetMx,
		mxResolutionMs: mxResolvedAt - startedAt,
		ips: results,
	};
}

let cached: { key: string; expiresAt: number; result: SmtpReachabilityResult } | undefined;
let inFlight: Promise<SmtpReachabilityResult> | undefined;

/** Cache/coalesce health polling so frequent probes do not hammer a remote MX. */
export async function getSmtpReachability(
	configuredIps: string[]
): Promise<SmtpReachabilityResult> {
	const normalized = [...new Set(configuredIps)].sort();
	const key = normalized.join(',');
	const now = Date.now();
	if (cached?.key === key && cached.expiresAt > now) return cached.result;
	if (inFlight) return inFlight;

	inFlight = probeSmtpReachability(normalized).then((result) => {
		cached = { key, expiresAt: Date.now() + CACHE_TTL_MS, result };
		return result;
	});
	try {
		return await inFlight;
	} finally {
		inFlight = undefined;
	}
}
