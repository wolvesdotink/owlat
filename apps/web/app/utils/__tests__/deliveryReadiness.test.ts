import { describe, expect, it } from 'vitest';
import type { OutboundTransportFacts } from '@owlat/shared';
import {
	deriveDeliveryReadiness,
	readinessInputFromSources,
	type ReadinessDomainRow,
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

describe('deriveDeliveryReadiness — MTA-STS enforce gate', () => {
	it('leaves a ready instance untouched when the flag is unset (default)', () => {
		const r = deriveDeliveryReadiness(input());
		expect(r.level).toBe('ready');
		expect(r.gates.find((g) => g.key === 'mta-sts')).toBeUndefined();
	});

	it('warns (incomplete) when enforce is published without the record, even if sending is otherwise ready', () => {
		const r = deriveDeliveryReadiness(input({ mtaStsEnforceWithoutRecord: true }));
		expect(r.canSend).toBe(true);
		expect(r.level).toBe('incomplete');
		expect(r.tone).toBe('warning');
		const g = gate(r, 'mta-sts');
		expect(g.status).toBe('attention');
		expect(g.tone).toBe('warning');
		expect(g.actionHref).toBe('/dashboard/delivery/domains');
		// The summary leads with the unfinished MTA-STS step.
		expect(r.summary).toContain('MTA-STS');
	});

	it('stays blocked (not merely incomplete) when the transport is also missing', () => {
		const r = deriveDeliveryReadiness(
			input({ transportConfigured: false, mtaStsEnforceWithoutRecord: true })
		);
		expect(r.level).toBe('blocked');
	});
});

describe('deriveDeliveryReadiness — sender-alignment gate', () => {
	it('leaves a ready instance untouched when the transport is aligned (default)', () => {
		const r = deriveDeliveryReadiness(input());
		expect(r.level).toBe('ready');
		expect(r.gates.find((g) => g.key === 'alignment')).toBeUndefined();
	});

	it('warns (incomplete) when the transport is misaligned, even if sending is otherwise ready', () => {
		const r = deriveDeliveryReadiness(
			input({
				transportMisaligned: true,
				misalignedDomains: ['acme.com'],
				alignmentReason: 'This relay signs as “sendgrid.net”, which isn’t part of “acme.com”.',
			})
		);
		expect(r.canSend).toBe(true);
		expect(r.level).toBe('incomplete');
		expect(r.tone).toBe('warning');
		const g = gate(r, 'alignment');
		expect(g.status).toBe('attention');
		expect(g.tone).toBe('warning');
		expect(g.actionHref).toBe('/dashboard/delivery/config');
		expect(g.detail).toContain('sendgrid.net');
		// The summary leads with the unfinished alignment step.
		expect(r.summary).toContain('sendgrid.net');
	});

	it('names the misaligned domains when no explicit reason is supplied', () => {
		const g = gate(
			deriveDeliveryReadiness(
				input({ transportMisaligned: true, misalignedDomains: ['acme.com', 'widgets.io'] })
			),
			'alignment'
		);
		expect(g.detail).toContain('acme.com, widgets.io');
	});

	it('stays blocked (not merely incomplete) when the transport is also missing', () => {
		const r = deriveDeliveryReadiness(
			input({ transportConfigured: false, transportMisaligned: true })
		);
		expect(r.level).toBe('blocked');
	});
});

describe('readinessInputFromSources — outbound alignment', () => {
	const verifiedRow: ReadinessDomainRow = { status: 'verified', missing: [] };
	const relayFacts = (over: Partial<OutboundTransportFacts> = {}): OutboundTransportFacts => ({
		kind: 'smtp',
		returnPathDomain: null,
		dkimDomain: null,
		...over,
	});

	it('warns for a relay that signs and bounces as its own foreign domain', () => {
		const result = readinessInputFromSources({ canSend: true }, [verifiedRow], null, {
			facts: relayFacts({ dkimDomain: 'sendgrid.net', returnPathDomain: 'sendgrid.net' }),
			fromDomains: ['acme.com'],
		});
		expect(result.transportMisaligned).toBe(true);
		expect(result.misalignedDomains).toEqual(['acme.com']);
		expect(result.alignmentReason).toContain('sendgrid.net');
	});

	it('passes for the built-in MTA (signs per From-domain)', () => {
		const result = readinessInputFromSources({ canSend: true }, [verifiedRow], null, {
			facts: { kind: 'mta', returnPathDomain: 'bounces.owlat.com', dkimDomain: null },
			fromDomains: ['acme.com'],
		});
		expect(result.transportMisaligned).toBe(false);
		expect(result.misalignedDomains).toEqual([]);
	});

	it('passes for a relay configured to sign as the sending domain', () => {
		const result = readinessInputFromSources({ canSend: true }, [verifiedRow], null, {
			facts: relayFacts({ dkimDomain: 'acme.com', returnPathDomain: 'bounce.acme.com' }),
			fromDomains: ['mail.acme.com'],
		});
		expect(result.transportMisaligned).toBe(false);
	});

	it('leaves alignment unset (no warning) when no alignment source is provided', () => {
		const result = readinessInputFromSources({ canSend: true }, [verifiedRow]);
		expect(result.transportMisaligned).toBe(false);
		expect(result.misalignedDomains).toEqual([]);
		expect(result.alignmentReason).toBeNull();
	});
});

describe('readinessInputFromSources — folding the two live sources', () => {
	function row(overrides: Partial<ReadinessDomainRow> = {}): ReadinessDomainRow {
		return { status: 'verified', missing: [], ...overrides };
	}

	it('reports auth against the most-active VERIFIED domain, not a more-active unverified one', () => {
		// Rows arrive most-active first: an unverified domain leads, a verified one
		// follows. Auth must be read from the verified one (what mail sends from).
		const rows: ReadinessDomainRow[] = [
			row({ status: 'pending', missing: ['SPF', 'DKIM', 'DMARC'] }),
			row({ status: 'verified', missing: ['DMARC'] }),
		];
		const result = readinessInputFromSources({ canSend: true }, rows);
		expect(result.domainVerified).toBe(true);
		expect(result.authMissing).toEqual(['DMARC']);
		expect(result.authComplete).toBe(false);
	});

	it('falls back to the most-active configured domain before any has verified', () => {
		const rows: ReadinessDomainRow[] = [
			row({ status: 'pending', missing: ['DKIM'] }),
			row({ status: 'failed', missing: ['SPF', 'DKIM', 'DMARC'] }),
		];
		const result = readinessInputFromSources({ canSend: false }, rows);
		expect(result.hasDomains).toBe(true);
		expect(result.domainVerified).toBe(false);
		// missing passthrough from the leading (most-active) row.
		expect(result.authMissing).toEqual(['DKIM']);
		expect(result.authComplete).toBe(false);
	});

	it('is fully unset with empty rows (no domain to authenticate)', () => {
		const result = readinessInputFromSources({ canSend: false }, []);
		expect(result).toEqual({
			transportConfigured: false,
			hasDomains: false,
			domainVerified: false,
			authComplete: false,
			authMissing: [],
			mtaStsEnforceWithoutRecord: false,
			transportMisaligned: false,
			misalignedDomains: [],
			alignmentReason: null,
		});
	});

	it('marks auth complete when the verified domain has no missing records', () => {
		const result = readinessInputFromSources({ canSend: true }, [row()]);
		expect(result.authComplete).toBe(true);
		expect(result.authMissing).toEqual([]);
	});

	it('carries transport canSend straight through', () => {
		expect(readinessInputFromSources({ canSend: true }, []).transportConfigured).toBe(true);
		expect(readinessInputFromSources({ canSend: false }, [row()]).transportConfigured).toBe(false);
	});

	it('warns only when MTA-STS enforce is published WITHOUT the record verified', () => {
		const enforceUnverified = readinessInputFromSources({ canSend: true }, [row()], {
			mode: 'enforce',
			recordVerified: false,
		});
		expect(enforceUnverified.mtaStsEnforceWithoutRecord).toBe(true);

		const enforceVerified = readinessInputFromSources({ canSend: true }, [row()], {
			mode: 'enforce',
			recordVerified: true,
		});
		expect(enforceVerified.mtaStsEnforceWithoutRecord).toBe(false);
	});

	it('never warns for testing/none modes or a missing (non-admin) source', () => {
		expect(
			readinessInputFromSources({ canSend: true }, [row()], {
				mode: 'testing',
				recordVerified: false,
			}).mtaStsEnforceWithoutRecord
		).toBe(false);
		expect(
			readinessInputFromSources({ canSend: true }, [row()], {
				mode: 'none',
				recordVerified: false,
			}).mtaStsEnforceWithoutRecord
		).toBe(false);
		expect(
			readinessInputFromSources({ canSend: true }, [row()], null).mtaStsEnforceWithoutRecord
		).toBe(false);
	});
});
