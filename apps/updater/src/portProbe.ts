/**
 * The sockets behind the port checks.
 *
 * Kept apart from the endpoint so the verdict mapping — which error code means
 * "a firewall ate this" versus "something answered and said no" — can be
 * exercised without a listener, and so the endpoint stays about HTTP.
 *
 * Probes write NOTHING: a TCP check connects and destroys the socket, so a
 * remote SMTP server sees a bare connection and no command. That is deliberate.
 * The point is the path, and an instance that speaks SMTP to a stranger's MX to
 * test its own firewall has told that MX something about itself for no reason.
 */
import { createConnection } from 'node:net';
import { resolveMx } from 'node:dns/promises';
import type { PortCheckStatus } from '@owlat/shared/networkPorts';

/** Long enough for a slow TLS-less handshake, short enough that ten of them fit in one request. */
export const PROBE_TIMEOUT_MS = 5_000;

export interface ProbeResult {
	status: PortCheckStatus;
	durationMs: number;
	/** The OS error code, when there was one — shown to no one, logged for support. */
	code?: string;
}

/**
 * A dropped packet and a closed port look different from here, and the
 * difference is the whole point of the card:
 *
 * - `ETIMEDOUT` / `EHOSTUNREACH` / `ENETUNREACH` — nothing came back. That is
 *   what a provider firewall that DROPS traffic looks like, so `blocked`.
 * - `ECONNREFUSED` / `ECONNRESET` — something answered. The path is open and
 *   the listener is missing or closed the door, so `refused`.
 * - `ENOTFOUND` / `EAI_AGAIN` — the name never resolved, so the port was never
 *   tried. Reporting that as a blocked port would send an operator to their
 *   firewall for a DNS fault.
 */
function statusForCode(code: string | undefined): PortCheckStatus {
	switch (code) {
		case undefined:
			return 'error';
		case 'ETIMEDOUT':
		case 'EHOSTUNREACH':
		case 'ENETUNREACH':
			return 'blocked';
		case 'ECONNREFUSED':
		case 'ECONNRESET':
			return 'refused';
		default:
			return 'error';
	}
}

/** True when the failure was the name lookup rather than the port. */
export function isNameResolutionCode(code: string | undefined): boolean {
	return code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA';
}

export interface TcpProbeArgs {
	host: string;
	port: number;
	timeoutMs?: number;
	now?: () => number;
}

/** Open a TCP connection, learn only whether it opened, and close it. */
export function probeTcp({
	host,
	port,
	timeoutMs = PROBE_TIMEOUT_MS,
	now = Date.now,
}: TcpProbeArgs): Promise<ProbeResult> {
	const startedAt = now();
	return new Promise<ProbeResult>((resolve) => {
		const socket = createConnection({ host, port });
		let settled = false;
		const finish = (status: PortCheckStatus, code?: string) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve({ status, durationMs: now() - startedAt, ...(code ? { code } : {}) });
		};

		socket.setTimeout(timeoutMs);
		socket.once('connect', () => finish('open'));
		// A socket timeout is not an error event: without this the probe would
		// hang for the OS connect timeout (over two minutes on Linux) and the
		// whole request with it.
		socket.once('timeout', () => finish('blocked', 'ETIMEDOUT'));
		socket.once('error', (err: Error & { code?: string }) => {
			if (isNameResolutionCode(err.code)) return finish('error', err.code);
			finish(statusForCode(err.code), err.code);
		});
	});
}

export interface DnsProbeArgs {
	domain: string;
	resolve?: typeof resolveMx;
	now?: () => number;
}

/**
 * Resolve a well-known domain's MX.
 *
 * Reaching a resolver is not the same as getting answers: a provider that
 * permits port 53 only to its own resolver still answers, whereas one that
 * drops the traffic times out. Delivery, domain verification and blocklist
 * lookups all sit on this working, so a timeout here is `blocked` — while
 * NXDOMAIN means the resolver answered fine and the probe's own domain is
 * wrong, which is our bug, not the operator's firewall.
 */
export async function probeDns({
	domain,
	resolve = resolveMx,
	now = Date.now,
}: DnsProbeArgs): Promise<ProbeResult> {
	const startedAt = now();
	try {
		const records = await resolve(domain);
		const status: PortCheckStatus = records.length > 0 ? 'open' : 'error';
		return { status, durationMs: now() - startedAt };
	} catch (err) {
		const code = (err as { code?: string }).code;
		const status: PortCheckStatus =
			code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ESERVFAIL' ? 'blocked' : 'error';
		return { status, durationMs: now() - startedAt, ...(code ? { code } : {}) };
	}
}
