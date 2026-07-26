import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../checklistProviderDetection', () => ({
	detectDomainDnsProvider: vi.fn(async () => null),
	detectIpProvider: vi.fn(async () => null),
	dnsProviderObservation: vi.fn(() => []),
}));
vi.mock('../../domains/dnsVerification', () => ({
	runDnsLookups: vi.fn(async () => ({ spf: { verified: true, foundValue: 'v=spf1 -all' } })),
}));

import { runDnsLookups } from '../../domains/dnsVerification';
import { detectDomainDnsProvider, detectIpProvider } from '../checklistProviderDetection';
import { observeDeploymentCheck } from '../checklistDeploymentValidators';
import { observeDomainCheck } from '../checklistDomainValidators';
import type { ChecklistVerificationContext } from '../checklistValidatorTypes';

const domainContext = {
	domain: {
		domain: 'example.test',
		dnsRecords: { spf: { value: 'v=spf1 -all' } },
	},
	settings: null,
	warming: null,
	routes: [],
	relayIdentities: [],
	tracking: [],
	postmaster: null,
} as unknown as ChecklistVerificationContext;

describe('checklist validator dependencies', () => {
	beforeEach(() => vi.clearAllMocks());

	it('does no unrelated network work for static and telemetry domain checks', async () => {
		await observeDomainCheck({} as never, 'domain.postmaster', domainContext, false);
		expect(detectDomainDnsProvider).not.toHaveBeenCalled();
		expect(runDnsLookups).not.toHaveBeenCalled();
	});

	it('loads provider and DNS observations only for DNS-backed checks that need them', async () => {
		await observeDomainCheck({} as never, 'domain.spf', domainContext, false);
		expect(detectDomainDnsProvider).toHaveBeenCalledTimes(1);
		expect(runDnsLookups).toHaveBeenCalledTimes(1);
	});

	it('does not run RDAP for warm-up but does for a provider-console PTR check', async () => {
		await observeDeploymentCheck('deployment.warmup', domainContext, false);
		expect(detectIpProvider).not.toHaveBeenCalled();
		await observeDeploymentCheck(
			'deployment.ptr',
			{
				...domainContext,
				warming: {
					syncedAt: Date.now(),
					ips: [{ ip: '203.0.113.10' }],
				},
			} as ChecklistVerificationContext,
			false
		);
		expect(detectIpProvider).toHaveBeenCalledTimes(1);
	});
});
