import { describe, expect, it } from 'vitest';
import {
	decodeSpamhausAnswers,
	evaluateIpAudit,
	IP_AUDIT_ZONES,
	neighbourhoodStatus,
	type IpAuditInput,
	type IpAuditZoneObservation,
} from '../ipAudit';
import { DNSBL_LISTS, dnsblZoneHost } from '../dnsbl';

const CHECKED_AT = 1_800_000_000_000;

function zone(
	zoneId: IpAuditZoneObservation['zoneId'],
	status: IpAuditZoneObservation['status'],
	answers: string[] = []
): IpAuditZoneObservation {
	return {
		zoneId,
		status,
		sublists: zoneId === 'spamhaus' ? decodeSpamhausAnswers(answers) : [],
		answers,
	};
}

function input(overrides: Partial<IpAuditInput> = {}): IpAuditInput {
	return {
		ip: '203.0.113.10',
		checkedAt: CHECKED_AT,
		port25: 'open',
		zones: [
			zone('spamhaus', 'clean'),
			zone('barracuda', 'clean'),
			zone('spamcop', 'clean'),
			zone('sorbs', 'clean'),
			zone('invaluement', 'skipped'),
			zone('abusix', 'skipped'),
		],
		fcrdns: { verdict: 'pass' },
		neighbourhood: { sampled: 15, listed: 0 },
		...overrides,
	};
}

describe('audit zone catalogue', () => {
	it('reuses the shipped Spamhaus, Barracuda and SpamCop zones', () => {
		const byId = new Map(IP_AUDIT_ZONES.map((entry) => [entry.id, entry]));
		expect(byId.get('spamhaus')?.zone).toBe('zen.spamhaus.org');
		expect(byId.get('barracuda')?.zone).toBe('b.barracudacentral.org');
		expect(byId.get('spamcop')?.zone).toBe('bl.spamcop.net');
	});

	it('reads the shipped zones from DNSBL_LISTS rather than re-declaring them', () => {
		// One source of truth: changing a zone in DNSBL_LISTS must move the audit
		// with it, and the keyed composition lives beside the zone it belongs to.
		for (const id of ['spamhaus', 'barracuda', 'spamcop', 'abusix'] as const) {
			const audit = IP_AUDIT_ZONES.find((entry) => entry.id === id);
			expect(audit?.zone).toBe(DNSBL_LISTS[id].zone);
			expect(audit?.addressFamilies).toBe(DNSBL_LISTS[id].addressFamilies);
			expect(audit?.requiresCredential).toBe(DNSBL_LISTS[id].requiresCredential);
		}
		expect(dnsblZoneHost(DNSBL_LISTS.abusix, 'key123')).toBe('key123.combined.mail.abusix.zone');
		expect(dnsblZoneHost(DNSBL_LISTS.abusix, undefined)).toBeNull();
		expect(dnsblZoneHost(DNSBL_LISTS.spamhaus, undefined)).toBe('zen.spamhaus.org');
	});

	it('marks the keyed feeds as credential-gated and IPv4-aware', () => {
		const invaluement = IP_AUDIT_ZONES.find((entry) => entry.id === 'invaluement');
		expect(invaluement?.requiresCredential).toBe(true);
		expect(IP_AUDIT_ZONES.find((entry) => entry.id === 'sorbs')?.addressFamilies).toEqual(['ipv4']);
	});
});

describe('Spamhaus return-code decoding', () => {
	it('maps each documented code to its sub-list', () => {
		expect(decodeSpamhausAnswers(['127.0.0.2'])).toEqual(['sbl']);
		expect(decodeSpamhausAnswers(['127.0.0.3'])).toEqual(['css']);
		expect(decodeSpamhausAnswers(['127.0.0.4', '127.0.0.7'])).toEqual(['xbl']);
		expect(decodeSpamhausAnswers(['127.0.0.10'])).toEqual(['pbl']);
		expect(decodeSpamhausAnswers(['127.0.0.9'])).toEqual(['drop']);
	});

	it('ignores codes it does not recognise', () => {
		expect(decodeSpamhausAnswers(['127.0.0.42', ''])).toEqual([]);
	});
});

describe('neighbourhood status', () => {
	it('withholds a verdict below the minimum sample', () => {
		expect(neighbourhoodStatus({ sampled: 4, listed: 4 })).toBe('insufficient_data');
		expect(neighbourhoodStatus({ sampled: 0, listed: 0 })).toBe('insufficient_data');
	});

	it('separates clean, mixed and noisy blocks', () => {
		expect(neighbourhoodStatus({ sampled: 16, listed: 1 })).toBe('clean');
		expect(neighbourhoodStatus({ sampled: 16, listed: 5 })).toBe('mixed');
		expect(neighbourhoodStatus({ sampled: 16, listed: 8 })).toBe('noisy');
	});
});

describe('evaluateIpAudit — the three outcomes', () => {
	it('calls a clean IP clean, with high confidence and a forward-looking action', () => {
		const report = evaluateIpAudit(input());
		expect(report.verdict).toBe('clean');
		expect(report.confidence).toBe('high');
		expect(report.findings).toEqual([]);
		expect(report.headline).toMatch(/clean/i);
		expect(report.nextAction).toMatch(/SPF/);
	});

	it('treats a PBL listing as fixable, not fatal', () => {
		const report = evaluateIpAudit(
			input({
				zones: [zone('spamhaus', 'listed', ['127.0.0.10'])],
			})
		);
		expect(report.verdict).toBe('action_required');
		expect(report.findings.map((finding) => finding.id)).toContain('spamhaus_pbl');
		expect(report.findings[0]?.sublist).toBe('pbl');
	});

	it('treats a CSS listing as fixable and names the snowshoe pattern', () => {
		const report = evaluateIpAudit(input({ zones: [zone('spamhaus', 'listed', ['127.0.0.3'])] }));
		expect(report.verdict).toBe('action_required');
		const css = report.findings.find((finding) => finding.id === 'spamhaus_css');
		expect(css?.message).toMatch(/snowshoe|cold/i);
	});

	it('reports SBL and XBL together when ZEN answers with both', () => {
		const report = evaluateIpAudit(
			input({ zones: [zone('spamhaus', 'listed', ['127.0.0.2', '127.0.0.4'])] })
		);
		expect(report.findings.map((finding) => finding.sublist)).toEqual(
			expect.arrayContaining(['sbl', 'xbl'])
		);
		expect(report.verdict).toBe('action_required');
	});

	it('collects a multi-zone listing into one finding per zone', () => {
		const report = evaluateIpAudit(
			input({
				zones: [
					zone('spamhaus', 'listed', ['127.0.0.2']),
					zone('barracuda', 'listed', ['127.0.0.2']),
					zone('spamcop', 'listed', ['127.0.0.2']),
				],
			})
		);
		expect(report.verdict).toBe('action_required');
		expect(report.findings.filter((finding) => finding.id === 'zone_listed')).toHaveLength(2);
		expect(report.headline).toMatch(/3 things/);
	});

	it('calls a DROP-listed range unusable and does not offer delisting', () => {
		const report = evaluateIpAudit(input({ zones: [zone('spamhaus', 'listed', ['127.0.0.9'])] }));
		expect(report.verdict).toBe('unusable');
		expect(report.headline).toMatch(/will not work/i);
		expect(report.nextAction).toMatch(/provider/i);
	});

	it('calls a silently blocked port 25 unusable', () => {
		const report = evaluateIpAudit(input({ port25: 'blocked' }));
		expect(report.verdict).toBe('unusable');
		expect(report.findings[0]?.id).toBe('port25_blocked');
		expect(report.findings[0]?.nextAction).toMatch(/relay|TCP\/25/);
	});

	it('asks for reverse DNS when the PTR is missing', () => {
		const report = evaluateIpAudit(input({ fcrdns: { verdict: 'fail', reason: 'no-ptr' } }));
		expect(report.verdict).toBe('action_required');
		expect(report.findings.map((finding) => finding.id)).toContain('no_ptr');
	});

	it('distinguishes an FCrDNS mismatch from a missing PTR', () => {
		const report = evaluateIpAudit(
			input({ fcrdns: { verdict: 'fail', reason: 'forward-mismatch' } })
		);
		expect(report.findings.map((finding) => finding.id)).toContain('fcrdns_mismatch');
		expect(report.findings.map((finding) => finding.id)).not.toContain('no_ptr');
	});

	it('accepts a generic provider PTR without a finding', () => {
		expect(evaluateIpAudit(input({ fcrdns: { verdict: 'warn' } })).verdict).toBe('clean');
	});

	it('calls a noisy /24 unusable even when the address itself is clean', () => {
		const report = evaluateIpAudit(input({ neighbourhood: { sampled: 14, listed: 9 } }));
		expect(report.verdict).toBe('unusable');
		expect(report.findings[0]?.id).toBe('noisy_neighbourhood');
	});

	it('keeps a mixed /24 usable and advisory only', () => {
		const report = evaluateIpAudit(input({ neighbourhood: { sampled: 16, listed: 4 } }));
		expect(report.verdict).toBe('clean');
		expect(report.findings.map((finding) => finding.id)).toEqual(['mixed_neighbourhood']);
	});

	it('never folds an unanswered Spamhaus lookup into clean', () => {
		const report = evaluateIpAudit(input({ zones: [zone('spamhaus', 'unknown')] }));
		expect(report.verdict).toBe('action_required');
		expect(report.confidence).toBe('low');
		expect(report.findings.map((finding) => finding.id)).toContain('audit_incomplete');
	});

	it('keeps an unconfirmed port 25 advisory: clean verdict, low confidence', () => {
		const report = evaluateIpAudit(input({ port25: 'unknown' }));
		expect(report.verdict).toBe('clean');
		expect(report.confidence).toBe('low');
		const finding = report.findings.find((entry) => entry.id === 'port25_unknown');
		expect(finding?.severity).toBe('advisory');
		expect(finding?.nextAction).toMatch(/re-run/i);
	});

	it('still reports a Spamhaus listing whose return code it cannot decode', () => {
		const observation = zone('spamhaus', 'listed', ['127.0.0.99']);
		expect(observation.sublists).toEqual([]);
		const report = evaluateIpAudit(input({ zones: [observation] }));
		expect(report.verdict).toBe('action_required');
		const listed = report.findings.filter((finding) => finding.id === 'zone_listed');
		expect(listed).toHaveLength(1);
		expect(listed[0]?.zoneId).toBe('spamhaus');
		expect(listed[0]?.severity).toBe('fixable');
	});

	it('keeps a non-Spamhaus zone that did not answer advisory only', () => {
		const report = evaluateIpAudit(
			input({
				zones: [
					zone('spamhaus', 'clean'),
					zone('barracuda', 'unknown'),
					zone('spamcop', 'unknown'),
				],
			})
		);
		expect(report.verdict).toBe('clean');
		expect(report.confidence).toBe('low');
		const incomplete = report.findings.find((finding) => finding.id === 'audit_incomplete');
		expect(incomplete?.severity).toBe('advisory');
		expect(incomplete?.zoneId).toBeUndefined();
		expect(incomplete?.message).toMatch(/2 blocklists did not answer/);
	});

	it('treats a skipped credential-gated feed as inert', () => {
		const report = evaluateIpAudit(
			input({
				zones: [
					zone('spamhaus', 'clean'),
					zone('invaluement', 'skipped'),
					zone('abusix', 'skipped'),
				],
			})
		);
		expect(report.verdict).toBe('clean');
		expect(report.confidence).toBe('high');
		expect(report.findings).toEqual([]);
	});

	it('sorts blocking findings ahead of fixable ones', () => {
		const report = evaluateIpAudit(
			input({
				port25: 'blocked',
				zones: [zone('spamhaus', 'listed', ['127.0.0.3'])],
				fcrdns: { verdict: 'fail', reason: 'no-ptr' },
			})
		);
		expect(report.verdict).toBe('unusable');
		expect(report.findings[0]?.severity).toBe('blocking');
	});

	it('echoes its inputs so the UI never has to re-derive them', () => {
		const report = evaluateIpAudit(input());
		expect(report.ip).toBe('203.0.113.10');
		expect(report.checkedAt).toBe(CHECKED_AT);
		expect(report.neighbourhoodStatus).toBe('clean');
		expect(report.port25).toBe('open');
	});
});
