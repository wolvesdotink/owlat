/**
 * Cached outbound SMTP reachability probe.
 *
 * A successful MX lookup only proves DNS works. Direct delivery also requires
 * the host to open TCP/25 from every configured sending IP, and cloud/VPS
 * providers commonly block exactly that path. This probe binds the same source
 * IP the sender uses and opens a TCP connection to a real recipient MX without
 * issuing an SMTP command or sending a message. Behind Docker NAT it binds
 * nothing, exactly like the sender (see smtp/sourceAddress.ts), and reports
 * that per IP as `sourceBinding: 'nat'`: a successful unbound connect proves
 * port 25 is open, not which address the NAT sent it from.
 */

import { resolve4, resolve6, resolveMx } from 'node:dns/promises';
import { createConnection } from 'node:net';
import { ipAddressFamily } from '@owlat/shared/ipAddress';
import { resolveSourceAddress, sharedNatEgressIps } from '../smtp/sourceAddress.js';

const PROBE_DOMAIN = 'gmail.com';
const PROBE_PORT = 25;
const CONNECT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

export type SmtpProbeFailureReason =
	| 'timeout'
	| 'connection_refused'
	| 'source_ip_unavailable'
	| 'network_unreachable'
	| 'target_resolution_error'
	| 'connection_error'
	/**
	 * Two or more same-family pool IPs are NATed onto one egress address, so
	 * per-IP pools, warming and reputation cannot be honoured; the MTA needs
	 * host networking to bind each IP. Port 25 is not probed for these IPs.
	 */
	| 'shared_nat_egress';

/**
 * How the sender's socket picks its source for this IP: `bound` binds the
 * configured address, `nat` binds nothing and leaves the source to the host's
 * NAT (see smtp/sourceAddress.ts). Additive on the `/health` wire: a Convex
 * build that predates it ignores the field.
 */
export type SmtpSourceBinding = 'bound' | 'nat';

export interface SmtpIpReachability {
	ip: string;
	status: 'ok' | 'failed';
	connectMs: number;
	reason?: SmtpProbeFailureReason;
	sourceBinding: SmtpSourceBinding;
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
	resolve4?: typeof resolve4;
	resolve6?: typeof resolve6;
	connect: (args: {
		host: string;
		port: number;
		/** Omitted when the kernel picks the source address (behind NAT). */
		localAddress?: string;
		timeoutMs: number;
	}) => Promise<void>;
	now: () => number;
	/** Defaults to the sender's own rule, `resolveSourceAddress`. */
	sourceAddressFor?: (ip: string) => string | undefined;
}

const defaultDeps: SmtpReachabilityDeps = {
	resolveMx,
	resolve4,
	resolve6,
	now: Date.now,
	connect: ({ host, port, localAddress, timeoutMs }) =>
		new Promise<void>((resolve, reject) => {
			const socket = createConnection({
				host,
				port,
				...(localAddress !== undefined ? { localAddress } : {}),
			});
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

/**
 * Run one uncached probe. Exported for deterministic unit tests.
 *
 * `targetDomain` defaults to the health probe's single well-known MX; the
 * pre-flight port-25 audit varies it so a silent provider block can be told
 * apart from one unreachable recipient.
 */
export async function probeSmtpReachability(
	configuredIps: string[],
	deps: SmtpReachabilityDeps = defaultDeps,
	targetDomain: string = PROBE_DOMAIN
): Promise<SmtpReachabilityResult> {
	const startedAt = deps.now();
	const ips = [...new Set(configuredIps)];
	const sourceAddressFor = deps.sourceAddressFor ?? ((ip: string) => resolveSourceAddress(ip));
	// Grouped before the MX lookup so a DNS failure still reports the collapse:
	// the Convex checklist reads `shared_nat_egress` to flag it, and a sweep that
	// lands during a DNS hiccup must not record a pass for it.
	const sharedNatIps = new Set(sharedNatEgressIps(ips, sourceAddressFor));
	const unprobed = (ip: string): SmtpIpReachability =>
		sharedNatIps.has(ip)
			? { ip, status: 'failed', connectMs: 0, reason: 'shared_nat_egress', sourceBinding: 'nat' }
			: {
					ip,
					status: 'failed',
					connectMs: 0,
					reason: 'connection_error',
					sourceBinding: sourceAddressFor(ip) === undefined ? 'nat' : 'bound',
				};
	let records: Awaited<ReturnType<typeof resolveMx>>;

	try {
		records = await deps.resolveMx(targetDomain);
	} catch {
		return {
			status: 'degraded',
			checkedAt: deps.now(),
			targetDomain,
			mxResolutionMs: deps.now() - startedAt,
			ips: ips.map(unprobed),
		};
	}

	const targetMx = [...records].sort((a, b) => a.priority - b.priority)[0]?.exchange;
	const mxResolvedAt = deps.now();
	if (!targetMx) {
		return {
			status: 'degraded',
			checkedAt: mxResolvedAt,
			targetDomain,
			mxResolutionMs: mxResolvedAt - startedAt,
			ips: ips.map(unprobed),
		};
	}

	const results = await Promise.all(
		ips.map(async (ip): Promise<SmtpIpReachability> => {
			const connectStartedAt = deps.now();
			if (sharedNatIps.has(ip)) return unprobed(ip);
			const localAddress = sourceAddressFor(ip);
			const binding: SmtpSourceBinding = localAddress === undefined ? 'nat' : 'bound';
			try {
				const family = ipAddressFamily(ip);
				const targetAddresses =
					family === 'ipv6'
						? await deps.resolve6?.(targetMx)
						: family === 'ipv4'
							? await deps.resolve4?.(targetMx)
							: undefined;
				if (targetAddresses && targetAddresses.length === 0) {
					return {
						ip,
						status: 'failed',
						connectMs: deps.now() - connectStartedAt,
						reason: 'target_resolution_error',
						sourceBinding: binding,
					};
				}
				await deps.connect({
					host: targetAddresses?.[0] ?? targetMx,
					port: PROBE_PORT,
					...(localAddress !== undefined ? { localAddress } : {}),
					timeoutMs: CONNECT_TIMEOUT_MS,
				});
				return {
					ip,
					status: 'ok',
					connectMs: deps.now() - connectStartedAt,
					sourceBinding: binding,
				};
			} catch (err) {
				const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
				return {
					ip,
					status: 'failed',
					connectMs: deps.now() - connectStartedAt,
					reason:
						code === 'ENODATA' || code === 'ENOTFOUND'
							? 'target_resolution_error'
							: failureReason(err),
					sourceBinding: binding,
				};
			}
		})
	);

	return {
		status: results.every((result) => result.status === 'ok') ? 'ok' : 'degraded',
		checkedAt: deps.now(),
		targetDomain,
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
