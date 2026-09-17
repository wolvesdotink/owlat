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
import { CONNREFUSED, lookup, NOTFOUND, SERVFAIL, TIMEOUT } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import type { PortCheckStatus } from '@owlat/shared/networkPorts';

/** Long enough for a slow TLS-less handshake, short enough that ten of them fit in one request. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * The name lookup gets its own, shorter budget, and is spent BEFORE the socket
 * budget starts — see {@link probeTcp} for why the two must not share one.
 */
export const LOOKUP_TIMEOUT_MS = 2_000;

/** One try, bounded: a resolver that drops our packets must not cost four rounds. */
const DNS_TRIES = 1;

export interface ProbeResult {
	status: PortCheckStatus;
	durationMs: number;
	/** The OS or resolver error code, when there was one. Carried so the endpoint can tell a name failure from a port one. */
	code?: string;
}

/**
 * A dropped packet and a closed port look different from here, and the
 * difference is the whole point of the card:
 *
 * - `ETIMEDOUT` / `EHOSTUNREACH` / `ENETUNREACH` — nothing came back. That is
 *   what a provider firewall that DROPS traffic looks like, so `blocked`.
 * - `ECONNREFUSED` / `ECONNRESET` — something answered. The path is open and
 *   the listener is missing or is rejecting us, so `refused`.
 * - anything else — we could not tell, which is its own answer.
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

/**
 * True when the failure was the name lookup rather than the port.
 *
 * `NOTFOUND` comes from `node:dns` rather than being spelled here, because the
 * DNS codes are NOT the socket ones — a resolver timeout is `ETIMEOUT`, a
 * socket timeout is `ETIMEDOUT` — and one transposed letter turns a verdict
 * into its opposite. `EAI_AGAIN` is written out: it comes from getaddrinfo, and
 * `node:dns` exports no constant for it (an absent constant is `undefined`,
 * which would then match every code-less success).
 *
 * The explicit `undefined` guard is that same trap, closed: a probe that
 * succeeded carries no code, and must never read as a name failure.
 */
export function isNameResolutionCode(code: string | undefined): boolean {
	if (code === undefined) return false;
	return code === NOTFOUND || code === 'EAI_AGAIN';
}

/** Resolver failures that mean the query never got an answer back. */
function isResolverPathFailure(code: string | undefined): boolean {
	if (code === undefined) return false;
	return code === TIMEOUT || code === 'ETIMEDOUT' || code === CONNREFUSED || code === SERVFAIL;
}

function elapsedSince(startedAt: number, now: () => number): number {
	return now() - startedAt;
}

interface LookupOutcome {
	address?: string;
	code?: string;
}

/**
 * Resolve `host` to one address, with its own budget.
 *
 * A compose service name resolves over the project network; a public name needs
 * the host's resolver. Either way this is a SEPARATE step from the connection
 * because the two fail for unrelated reasons — see {@link probeTcp}.
 */
function lookupHost(host: string, timeoutMs: number): Promise<LookupOutcome> {
	return new Promise<LookupOutcome>((resolve) => {
		let settled = false;
		const finish = (outcome: LookupOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(outcome);
		};
		const timer = setTimeout(() => finish({ code: TIMEOUT }), timeoutMs);
		lookup(host, (err: (Error & { code?: string }) | null, address: string) => {
			if (err) return finish({ code: err.code ?? NOTFOUND });
			finish({ address });
		});
	});
}

export interface TcpProbeArgs {
	host: string;
	port: number;
	timeoutMs?: number;
	lookupTimeoutMs?: number;
	now?: () => number;
}

/**
 * Open a TCP connection, learn only whether it opened, and close it.
 *
 * The name is resolved FIRST, and the socket is opened against the address.
 * Letting `net.connect` do its own lookup shares one deadline between two
 * different failures: with port 53 dropped, every lookup hangs, every socket
 * times out, and all six outbound rows read `blocked` — pointing the operator
 * at a firewall rule for what is a DNS fault. Resolving separately keeps a name
 * failure a name failure, which the endpoint then reads as `skipped` for an
 * inbound service that simply is not deployed.
 */
export async function probeTcp({
	host,
	port,
	timeoutMs = PROBE_TIMEOUT_MS,
	lookupTimeoutMs = LOOKUP_TIMEOUT_MS,
	now = Date.now,
}: TcpProbeArgs): Promise<ProbeResult> {
	const startedAt = now();

	const resolved = await lookupHost(host, lookupTimeoutMs);
	if (!resolved.address) {
		// Never a port verdict: the socket was not attempted. The endpoint reads
		// the CODE to tell "this service is not deployed here" (NXDOMAIN on a
		// compose name) from "our resolver is broken" (a timeout).
		return {
			status: 'error',
			durationMs: elapsedSince(startedAt, now),
			...(resolved.code ? { code: resolved.code } : {}),
		};
	}

	return new Promise<ProbeResult>((resolve) => {
		const socket = createConnection({ host: resolved.address, port });
		let settled = false;
		const finish = (status: PortCheckStatus, code?: string) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve({ status, durationMs: elapsedSince(startedAt, now), ...(code ? { code } : {}) });
		};

		socket.setTimeout(timeoutMs);
		socket.once('connect', () => finish('open'));
		// A socket timeout is not an error event: without this the probe would
		// hang for the OS connect timeout (over two minutes on Linux) and the
		// whole request with it.
		socket.once('timeout', () => finish('blocked', 'ETIMEDOUT'));
		socket.once('error', (err: Error & { code?: string }) => {
			finish(statusForCode(err.code), err.code);
		});
	});
}

export interface DnsProbeArgs {
	domain: string;
	resolve?: (domain: string) => Promise<unknown[]>;
	now?: () => number;
}

/** A resolver that gives up once, quickly, instead of riding the four-try default. */
function boundedResolveMx(domain: string): Promise<unknown[]> {
	const resolver = new Resolver({ timeout: PROBE_TIMEOUT_MS, tries: DNS_TRIES });
	return resolver.resolveMx(domain);
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
	resolve = boundedResolveMx,
	now = Date.now,
}: DnsProbeArgs): Promise<ProbeResult> {
	const startedAt = now();
	try {
		const records = await resolve(domain);
		const status: PortCheckStatus = records.length > 0 ? 'open' : 'error';
		return { status, durationMs: elapsedSince(startedAt, now) };
	} catch (err) {
		const code = (err as { code?: string }).code;
		const status: PortCheckStatus = isResolverPathFailure(code) ? 'blocked' : 'error';
		return { status, durationMs: elapsedSince(startedAt, now), ...(code ? { code } : {}) };
	}
}
