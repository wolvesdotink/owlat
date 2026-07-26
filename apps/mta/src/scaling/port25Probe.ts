/**
 * Pre-flight outbound port-25 egress probe.
 *
 * Many VPS providers block outbound TCP/25 by dropping the packets rather than
 * refusing them, so a single failed connection is indistinguishable from one
 * unreachable recipient. This probe binds the sending address and opens a plain
 * TCP connection to several independent well-known MX hosts: consistent silence
 * across all of them is the signature of a provider block.
 *
 * It reuses the shipped reachability probe rather than opening a second socket
 * path, and the whole thing is bounded by a deadline — an audit that hangs is an
 * audit nobody runs.
 */

import type { Port25EgressStatus } from '@owlat/shared/ipAudit';
import {
	probeSmtpReachability,
	type SmtpProbeFailureReason,
	type SmtpReachabilityDeps,
} from '../routes/smtpReachability.js';

/** Independent operators: one of them being down must not read as a block. */
export const PORT25_PROBE_DOMAINS = ['gmail.com', 'outlook.com', 'yahoo.com'] as const;

/** Whole-probe budget. Individual connects are already capped by the shipped probe. */
export const PORT25_PROBE_DEADLINE_MS = 20_000;

export type Port25TargetOutcome =
	| 'connected'
	| 'timeout'
	| 'refused'
	| 'unreachable'
	| 'resolution_error'
	| 'error';

export interface Port25TargetResult {
	domain: string;
	outcome: Port25TargetOutcome;
	mx?: string;
	elapsedMs: number;
}

export type Port25Reason =
	| 'connected'
	| 'all_targets_timed_out'
	| 'insufficient_targets'
	| 'probe_deadline_exceeded'
	| 'inconclusive';

export interface Port25ProbeResult {
	ip: string;
	status: Port25EgressStatus;
	reason: Port25Reason;
	checkedAt: number;
	targets: Port25TargetResult[];
}

export interface Port25ProbeDeps {
	now: () => number;
	/** Omitted in production: the shipped probe supplies the real socket path. */
	reachability?: SmtpReachabilityDeps;
	deadlineMs?: number;
	domains?: readonly string[];
}

function outcomeFor(reason: SmtpProbeFailureReason | undefined): Port25TargetOutcome {
	switch (reason) {
		case 'timeout':
			return 'timeout';
		case 'connection_refused':
			return 'refused';
		case 'network_unreachable':
		case 'source_ip_unavailable':
			return 'unreachable';
		case 'target_resolution_error':
			return 'resolution_error';
		default:
			return 'error';
	}
}

/**
 * Classify a set of per-target outcomes. Pure: no clock, no sockets.
 *
 * One success proves egress. Consistent silence across at least two independent
 * operators is a provider block. Everything else is inconclusive, and
 * inconclusive is reported as UNKNOWN — never as clean and never as blocked.
 */
export function classifyPort25(targets: readonly Port25TargetResult[]): {
	status: Port25EgressStatus;
	reason: Port25Reason;
} {
	if (targets.length === 0) return { status: 'unknown', reason: 'insufficient_targets' };
	if (targets.some((target) => target.outcome === 'connected')) {
		return { status: 'open', reason: 'connected' };
	}
	const timedOut = targets.filter((target) => target.outcome === 'timeout');
	if (timedOut.length === targets.length && targets.length >= 2) {
		return { status: 'blocked', reason: 'all_targets_timed_out' };
	}
	if (timedOut.length > 0 && targets.length < 2) {
		return { status: 'unknown', reason: 'insufficient_targets' };
	}
	return { status: 'unknown', reason: 'inconclusive' };
}

/** Probe one sending address against every configured target, under a deadline. */
export async function probePort25Egress(
	ip: string,
	deps: Port25ProbeDeps
): Promise<Port25ProbeResult> {
	const domains = deps.domains ?? PORT25_PROBE_DOMAINS;
	const deadlineMs = deps.deadlineMs ?? PORT25_PROBE_DEADLINE_MS;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<'deadline'>((resolve) => {
		deadlineTimer = setTimeout(() => resolve('deadline'), deadlineMs);
	});

	const probes = Promise.all(
		domains.map(async (domain): Promise<Port25TargetResult> => {
			const targetStartedAt = deps.now();
			try {
				const result = await probeSmtpReachability([ip], deps.reachability, domain);
				const observation = result.ips[0];
				return {
					domain,
					outcome: observation?.status === 'ok' ? 'connected' : outcomeFor(observation?.reason),
					...(result.targetMx ? { mx: result.targetMx } : {}),
					elapsedMs: deps.now() - targetStartedAt,
				};
			} catch {
				return { domain, outcome: 'error', elapsedMs: deps.now() - targetStartedAt };
			}
		})
	);

	try {
		const settled = await Promise.race([probes, deadline]);
		if (settled === 'deadline') {
			return {
				ip,
				status: 'unknown',
				reason: 'probe_deadline_exceeded',
				checkedAt: deps.now(),
				targets: [],
			};
		}
		const { status, reason } = classifyPort25(settled);
		return { ip, status, reason, checkedAt: deps.now(), targets: settled };
	} finally {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		// The in-flight probes are already bounded by the shipped connect timeout;
		// swallow their late rejection so the deadline path never leaks one.
		void probes.catch(() => undefined);
	}
}
