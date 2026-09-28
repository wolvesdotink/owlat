import { describe, expect, it, vi } from 'vitest';

vi.mock('../checklistProviderDetection', () => ({
	detectIpProvider: vi.fn(async () => null),
}));

import { observeDeploymentCheck } from '../checklistDeploymentValidators';
import { parseHealth } from '../mtaHealth';
import { port25AwaitsSourceAddress } from '../checklistSmtpProbe';
import type { ChecklistVerificationContext } from '../checklistValidatorTypes';

type ProbeIp = {
	ip: string;
	status: 'ok' | 'failed';
	reason?: string;
	sourceBinding?: 'bound' | 'nat';
};

function context(ips: ProbeIp[], observedAt = Date.now()): ChecklistVerificationContext {
	return {
		domain: null,
		settings: {
			mtaHealth: {
				status: ips.every((entry) => entry.status === 'ok') ? 'ok' : 'degraded',
				observedAt,
				smtpOutbound: {
					status: ips.every((entry) => entry.status === 'ok') ? 'ok' : 'degraded',
					checkedAt: observedAt,
					ips,
				},
			},
		} as ChecklistVerificationContext['settings'],
		routes: [],
		relayIdentities: [],
		readyRelayKinds: [],
		tracking: [],
		postmaster: null,
		warming: {
			syncedAt: Date.now(),
			phase: 'graduated',
			totalDailyCap: 1,
			totalSentToday: 0,
			ipCount: ips.length,
			ips: ips.map((entry) => ({
				ip: entry.ip,
				phase: 'graduated',
				currentDay: 30,
				dailyCap: 1,
				sentToday: 0,
				bounceRate: 0,
				deferralRate: 0,
				pool: 'campaign',
				active: true,
				dnsbl: 'clean',
			})),
		} as ChecklistVerificationContext['warming'],
	};
}

const SHARED_NAT: ProbeIp[] = [
	{ ip: '203.0.113.10', status: 'failed', reason: 'shared_nat_egress', sourceBinding: 'nat' },
	{ ip: '203.0.113.11', status: 'failed', reason: 'shared_nat_egress', sourceBinding: 'nat' },
];

describe('deployment.source_ip', () => {
	it('fails and explains the collapse when pool IPs share one NAT egress address', async () => {
		const observation = await observeDeploymentCheck(
			'deployment.source_ip',
			context(SHARED_NAT),
			false
		);
		expect(observation.status).toBe('fail');
		expect(observation.diagnostic).toContain('203.0.113.10, 203.0.113.11 share one NAT egress');
		expect(observation.diagnostic).toContain('host networking');
		expect(observation.diagnostic).toContain('Delivery continues');
		expect(observation.observedValues).toEqual([
			'203.0.113.10=shared-nat',
			'203.0.113.11=shared-nat',
		]);
	});

	it('also reads the collapse from an MTA that predates sourceBinding', async () => {
		const legacy = SHARED_NAT.map(({ sourceBinding: _binding, ...entry }) => entry);
		await expect(
			observeDeploymentCheck('deployment.source_ip', context(legacy), false)
		).resolves.toMatchObject({ status: 'fail' });
	});

	it('reads the collapse from the bindings when the probe carries no reason code for it', async () => {
		// An MX lookup that fails before the MTA groups the addresses reports them
		// as plain connection errors; two NATed IPv4 addresses still share one egress.
		const observation = await observeDeploymentCheck(
			'deployment.source_ip',
			context([
				{ ip: '203.0.113.10', status: 'failed', reason: 'connection_error', sourceBinding: 'nat' },
				{ ip: '203.0.113.11', status: 'failed', reason: 'connection_error', sourceBinding: 'nat' },
				{
					ip: '198.51.100.7',
					status: 'failed',
					reason: 'connection_error',
					sourceBinding: 'bound',
				},
			]),
			false
		);
		expect(observation.status).toBe('fail');
		expect(observation.diagnostic).toContain('203.0.113.10, 203.0.113.11 share one NAT egress');
		expect(observation.observedValues).toEqual([
			'203.0.113.10=shared-nat',
			'203.0.113.11=shared-nat',
			'198.51.100.7=bound',
		]);
	});

	it('passes a single NATed IP but says the translated source cannot be confirmed', async () => {
		const observation = await observeDeploymentCheck(
			'deployment.source_ip',
			context([{ ip: '203.0.113.10', status: 'ok', sourceBinding: 'nat' }]),
			false
		);
		expect(observation.status).toBe('pass');
		expect(observation.diagnostic).toContain('203.0.113.10 is sent through NAT');
		expect(observation.diagnostic).toContain('cannot see the translated source address');
		expect(observation.observedValues).toEqual(['203.0.113.10=nat']);
	});

	it('passes bound addresses without a NAT caveat', async () => {
		const observation = await observeDeploymentCheck(
			'deployment.source_ip',
			context([
				{ ip: '203.0.113.10', status: 'ok', sourceBinding: 'bound' },
				{ ip: '203.0.113.11', status: 'ok', sourceBinding: 'bound' },
			]),
			false
		);
		expect(observation).toMatchObject({
			status: 'pass',
			diagnostic: 'Every sending address is bound to its own IP.',
		});
	});

	it('refuses to judge a stale health snapshot', async () => {
		await expect(
			observeDeploymentCheck(
				'deployment.source_ip',
				context(SHARED_NAT, Date.now() - 10 * 60_000),
				false
			)
		).resolves.toMatchObject({ status: 'warn', diagnostic: expect.stringContaining('too old') });
	});
});

describe('deployment.port25 with shared NAT egress', () => {
	it('warns instead of reporting a port-25 block for addresses the MTA did not probe', async () => {
		const observation = await observeDeploymentCheck(
			'deployment.port25',
			context(SHARED_NAT),
			false
		);
		expect(observation.status).toBe('warn');
		expect(observation.diagnostic).toContain('not probed');
		expect(observation.observedValues).toEqual([
			'203.0.113.10=not-probed',
			'203.0.113.11=not-probed',
		]);
	});

	it('still fails on a real probe failure next to a shared-NAT address', async () => {
		await expect(
			observeDeploymentCheck(
				'deployment.port25',
				context([...SHARED_NAT, { ip: '203.0.113.12', status: 'failed', reason: 'timeout' }]),
				false
			)
		).resolves.toMatchObject({
			status: 'fail',
			diagnostic: 'The live port-25 probe failed for at least one source address.',
		});
	});
});

describe('port25AwaitsSourceAddress', () => {
	it('is true only when the port-25 evidence names an unprobed address', () => {
		expect(port25AwaitsSourceAddress(['203.0.113.10=not-probed', '203.0.113.12=ok'])).toBe(true);
		expect(port25AwaitsSourceAddress(['203.0.113.10=failed'])).toBe(false);
		expect(port25AwaitsSourceAddress([])).toBe(false);
	});
});

describe('parseHealth sourceBinding', () => {
	const health = (ips: unknown[]) => ({
		status: 'ok',
		redis: 'connected',
		worker: { alive: true },
		dns: 'ok',
		emergency: { allIpsBlocked: false },
		smtpOutbound: { status: 'ok', checkedAt: 1, ips },
	});

	it('keeps a known source binding and drops an unknown one', () => {
		const snapshot = parseHealth(
			health([
				{ ip: '203.0.113.10', status: 'ok', sourceBinding: 'nat' },
				{ ip: '203.0.113.11', status: 'ok', sourceBinding: 'tunnel' },
				{ ip: '203.0.113.12', status: 'ok' },
			]),
			2
		);
		expect(snapshot?.smtpOutbound?.ips).toEqual([
			{ ip: '203.0.113.10', status: 'ok', sourceBinding: 'nat' },
			{ ip: '203.0.113.11', status: 'ok' },
			{ ip: '203.0.113.12', status: 'ok' },
		]);
	});
});
