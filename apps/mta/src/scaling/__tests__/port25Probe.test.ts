import { describe, expect, it } from 'vitest';
import type { MxRecord } from 'node:dns';
import {
	classifyPort25,
	PORT25_PROBE_DOMAINS,
	probePort25Egress,
	type Port25TargetResult,
} from '../port25Probe.js';
import type { SmtpReachabilityDeps } from '../../routes/smtpReachability.js';

function codedError(code: string): Error & { code: string } {
	const error = new Error(code) as Error & { code: string };
	error.code = code;
	return error;
}

const resolveMxStub = ((hostname: string): Promise<MxRecord[]> =>
	Promise.resolve([
		{ exchange: `mx.${hostname}`, priority: 10 },
	])) as unknown as SmtpReachabilityDeps['resolveMx'];

/** Reachability deps whose connect outcome is decided per target domain. */
function reachability(
	connectByDomain: Record<string, 'ok' | 'timeout' | 'refused' | 'hang'>
): SmtpReachabilityDeps {
	return {
		resolveMx: resolveMxStub,
		now: () => 0,
		connect: ({ host }) => {
			const domain = host.replace(/^mx\./, '');
			const outcome = connectByDomain[domain] ?? 'ok';
			if (outcome === 'ok') return Promise.resolve();
			if (outcome === 'hang') return new Promise<void>(() => undefined);
			return Promise.reject(codedError(outcome === 'timeout' ? 'ETIMEDOUT' : 'ECONNREFUSED'));
		},
	};
}

const DOMAINS = [...PORT25_PROBE_DOMAINS];

function target(domain: string, outcome: Port25TargetResult['outcome']): Port25TargetResult {
	return { domain, outcome, elapsedMs: 1 };
}

describe('classifyPort25', () => {
	it('calls egress open as soon as one target connects', () => {
		expect(
			classifyPort25([
				target('gmail.com', 'timeout'),
				target('outlook.com', 'connected'),
				target('yahoo.com', 'timeout'),
			])
		).toEqual({ status: 'open', reason: 'connected' });
	});

	it('calls consistent silence across independent operators a block', () => {
		expect(
			classifyPort25([
				target('gmail.com', 'timeout'),
				target('outlook.com', 'timeout'),
				target('yahoo.com', 'timeout'),
			])
		).toEqual({ status: 'blocked', reason: 'all_targets_timed_out' });
	});

	it('refuses to call a single timed-out target a block', () => {
		expect(classifyPort25([target('gmail.com', 'timeout')])).toEqual({
			status: 'unknown',
			reason: 'insufficient_targets',
		});
	});

	it('reports refusals and resolution failures as unknown, never as clean', () => {
		expect(
			classifyPort25([target('gmail.com', 'refused'), target('yahoo.com', 'refused')])
		).toEqual({ status: 'unknown', reason: 'inconclusive' });
		expect(
			classifyPort25([target('gmail.com', 'resolution_error'), target('yahoo.com', 'timeout')])
		).toEqual({ status: 'unknown', reason: 'inconclusive' });
	});

	it('reports no targets at all as unknown', () => {
		expect(classifyPort25([])).toEqual({ status: 'unknown', reason: 'insufficient_targets' });
	});
});

describe('probePort25Egress', () => {
	it('classifies open egress and records every target', async () => {
		const result = await probePort25Egress('203.0.113.10', {
			now: () => 1_000,
			reachability: reachability({}),
			domains: DOMAINS,
		});
		expect(result.status).toBe('open');
		expect(result.reason).toBe('connected');
		expect(result.targets.map((entry) => entry.domain)).toEqual(DOMAINS);
		expect(result.targets.every((entry) => entry.outcome === 'connected')).toBe(true);
	});

	it('classifies a silently blocked provider from consistent timeouts', async () => {
		const result = await probePort25Egress('203.0.113.10', {
			now: () => 1_000,
			reachability: reachability({
				'gmail.com': 'timeout',
				'outlook.com': 'timeout',
				'yahoo.com': 'timeout',
			}),
			domains: DOMAINS,
		});
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('all_targets_timed_out');
	});

	it('stays open when only one operator is unreachable', async () => {
		const result = await probePort25Egress('203.0.113.10', {
			now: () => 1_000,
			reachability: reachability({ 'gmail.com': 'timeout' }),
			domains: DOMAINS,
		});
		expect(result.status).toBe('open');
		expect(result.targets.find((entry) => entry.domain === 'gmail.com')?.outcome).toBe('timeout');
	});

	it('is bounded by its own deadline when a connect never settles', async () => {
		const startedAt = Date.now();
		const result = await probePort25Egress('203.0.113.10', {
			now: () => 1_000,
			reachability: reachability({
				'gmail.com': 'hang',
				'outlook.com': 'hang',
				'yahoo.com': 'hang',
			}),
			domains: DOMAINS,
			deadlineMs: 25,
		});
		expect(result.status).toBe('unknown');
		expect(result.reason).toBe('probe_deadline_exceeded');
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	it('never reports a hung probe as open or blocked', async () => {
		const result = await probePort25Egress('203.0.113.10', {
			now: () => 1_000,
			reachability: reachability({ 'gmail.com': 'hang' }),
			domains: ['gmail.com'],
			deadlineMs: 20,
		});
		expect(result.status).toBe('unknown');
		expect(result.targets).toEqual([]);
	});

	it('does not throw when the MX lookup itself fails', async () => {
		const result = await probePort25Egress('203.0.113.10', {
			now: () => 1_000,
			reachability: {
				...reachability({}),
				resolveMx: (() =>
					Promise.reject(codedError('ESERVFAIL'))) as unknown as SmtpReachabilityDeps['resolveMx'],
			},
			domains: DOMAINS,
		});
		expect(result.status).toBe('unknown');
		expect(result.targets.every((entry) => entry.outcome === 'error')).toBe(true);
	});
});
