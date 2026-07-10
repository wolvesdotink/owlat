import { describe, expect, it } from 'vitest';
import {
	deriveDeliveryReadiness,
	type ReadinessGateKey,
	type ReadinessInput,
} from '../deliveryReadiness';

/** A fully-ready instance; override one fact at a time to exercise each gate. */
function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
	return {
		transportConfigured: true,
		hasDomains: true,
		domainVerified: true,
		authComplete: true,
		authMissing: [],
		...overrides,
	};
}

function gate(readiness: ReturnType<typeof deriveDeliveryReadiness>, key: ReadinessGateKey) {
	const found = readiness.gates.find((g) => g.key === key);
	if (!found) throw new Error(`missing gate ${key}`);
	return found;
}

describe('deriveDeliveryReadiness — overall level', () => {
	it('is ready only when transport, a verified domain and full auth are all present', () => {
		const r = deriveDeliveryReadiness(input());
		expect(r.level).toBe('ready');
		expect(r.canSend).toBe(true);
		expect(r.tone).toBe('success');
		expect(r.headline).toBe('Ready to send');
	});

	it('is blocked with no transport (the hard gate) — canSend false, red', () => {
		const r = deriveDeliveryReadiness(input({ transportConfigured: false }));
		expect(r.level).toBe('blocked');
		expect(r.canSend).toBe(false);
		expect(r.tone).toBe('error');
	});

	it('is blocked when the transport is set but no domain is verified', () => {
		const r = deriveDeliveryReadiness(
			input({ domainVerified: false, hasDomains: true, authComplete: false, authMissing: ['DKIM'] })
		);
		expect(r.level).toBe('blocked');
		expect(r.canSend).toBe(false);
	});

	it('is incomplete when it CAN send but authentication is unfinished', () => {
		const r = deriveDeliveryReadiness(input({ authComplete: false, authMissing: ['DMARC'] }));
		expect(r.level).toBe('incomplete');
		expect(r.canSend).toBe(true);
		expect(r.tone).toBe('warning');
		expect(r.headline).toBe('Ready to send — finish setup');
	});
});

describe('deriveDeliveryReadiness — transport gate', () => {
	it('is ready and action-free when configured', () => {
		const g = gate(deriveDeliveryReadiness(input()), 'transport');
		expect(g.status).toBe('ready');
		expect(g.tone).toBe('success');
		expect(g.actionHref).toBeNull();
	});

	it('is attention with a fix link to the transport editor when unset', () => {
		const g = gate(deriveDeliveryReadiness(input({ transportConfigured: false })), 'transport');
		expect(g.status).toBe('attention');
		expect(g.tone).toBe('error');
		expect(g.actionHref).toBe('/dashboard/delivery/config');
	});
});

describe('deriveDeliveryReadiness — domain gate', () => {
	it('is ready when a domain is verified', () => {
		expect(gate(deriveDeliveryReadiness(input()), 'domain').status).toBe('ready');
	});

	it('is attention with an add-domain link when none exists', () => {
		const g = gate(
			deriveDeliveryReadiness(
				input({ hasDomains: false, domainVerified: false, authComplete: false })
			),
			'domain'
		);
		expect(g.status).toBe('attention');
		expect(g.actionLabel).toBe('Add a domain');
		expect(g.actionHref).toBe('/dashboard/delivery/domains');
	});

	it('is pending (waiting on DNS) when a domain exists but is unverified', () => {
		const g = gate(
			deriveDeliveryReadiness(
				input({ domainVerified: false, authComplete: false, authMissing: ['SPF'] })
			),
			'domain'
		);
		expect(g.status).toBe('pending');
		expect(g.actionLabel).toBe('Check verification');
	});
});

describe('deriveDeliveryReadiness — authentication gate', () => {
	it('stays neutral/pending before any domain exists (not red)', () => {
		const g = gate(
			deriveDeliveryReadiness(
				input({ hasDomains: false, domainVerified: false, authComplete: false })
			),
			'authentication'
		);
		expect(g.status).toBe('pending');
		expect(g.tone).toBe('neutral');
		expect(g.actionHref).toBeNull();
	});

	it('names the specific missing records', () => {
		const g = gate(
			deriveDeliveryReadiness(input({ authComplete: false, authMissing: ['DKIM', 'DMARC'] })),
			'authentication'
		);
		expect(g.status).toBe('attention');
		expect(g.detail).toContain('DKIM, DMARC');
		expect(g.actionHref).toBe('/dashboard/delivery/domains');
	});

	it('is ready when SPF, DKIM and DMARC are all present', () => {
		expect(gate(deriveDeliveryReadiness(input()), 'authentication').status).toBe('ready');
	});
});

describe('deriveDeliveryReadiness — summary', () => {
	it('leads with the first unfinished gate', () => {
		const r = deriveDeliveryReadiness(input({ transportConfigured: false }));
		expect(r.summary).toContain('No transport is configured');
	});

	it('gives an all-clear line when everything is ready', () => {
		expect(deriveDeliveryReadiness(input()).summary).toContain('can send');
	});
});
