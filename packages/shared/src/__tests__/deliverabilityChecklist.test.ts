import { describe, expect, it } from 'vitest';
import {
	DELIVERABILITY_CHECKLIST,
	DELIVERABILITY_NOT_MEASURED,
	deliverabilityNotGradedReason,
	dependenciesPass,
	deriveDeliverabilityGrade,
	materializeChecklistItem,
	selectNextDeliverabilityItem,
	type DeliverabilityChecklistItem,
} from '../deliverabilityChecklist';
import { sanitizeDeliverabilityText } from '../deliverabilityDiagnostics';

const domainSpf = DELIVERABILITY_CHECKLIST.find((item) => item.id === 'domain.spf')!;
const domainDkim = DELIVERABILITY_CHECKLIST.find((item) => item.id === 'domain.dkim')!;
const domainDmarc = DELIVERABILITY_CHECKLIST.find((item) => item.id === 'domain.dmarc')!;

function item(
	definition: typeof domainSpf,
	domainId: string,
	status: DeliverabilityChecklistItem['status']
): DeliverabilityChecklistItem {
	return materializeChecklistItem(
		definition,
		{ kind: 'domain', domainId, domain: `${domainId}.example` },
		{
			provenance: 'validator',
			validator: 'test',
			status,
			observedAt: 10,
			observedValues: [],
			diagnostic: status,
			attemptId: `attempt-${domainId}-${definition.id}`,
		},
		10
	);
}

describe('deliverability checklist reducer', () => {
	it('strips C0, DEL, C1, and bidi controls from diagnostic text', () => {
		const unsafe =
			'visible\u0000\u007f\u0085\u009f\u061c\u200e\u200f\u2028\u2029\u202a\u202e\u2066\u2069safe\nnext';
		expect(sanitizeDeliverabilityText(unsafe)).toBe('visiblesafe\nnext');
	});

	it('links to the canonical external docs guides and stable anchors', () => {
		expect(
			DELIVERABILITY_CHECKLIST.every((entry) =>
				entry.docsHref.startsWith('https://docs.owlat.app/')
			)
		).toBe(true);
		expect(
			DELIVERABILITY_CHECKLIST.find((entry) => entry.id === 'deployment.ptr')?.docsHref
		).toContain('/guide/sending-from-a-vps#');
		expect(DELIVERABILITY_CHECKLIST.find((entry) => entry.id === 'domain.spf')?.docsHref).toContain(
			'/guide/deliverability#'
		);
	});

	it('does not synthesize a pass without validator evidence', () => {
		const result = materializeChecklistItem(
			domainSpf,
			{ kind: 'domain', domainId: 'a', domain: 'a' },
			null,
			10
		);
		expect(result).toMatchObject({ status: 'fail' });
		expect(result).not.toHaveProperty('lastCheckedAt');
	});

	it('builds a bounded copied report with check, scope, status, timestamp, and raw evidence', () => {
		const observedAt = Date.UTC(2026, 6, 26, 12, 34, 56);
		const result = materializeChecklistItem(
			domainSpf,
			{ kind: 'domain', domainId: 'domain-a', domain: 'example.test' },
			{
				provenance: 'validator',
				validator: 'dns.spf',
				status: 'fail',
				observedAt,
				observedValues: ['ptr=mail.example.test\nStatus: pass', 'reason=value mismatch'],
				diagnostic: 'SPF mismatch\r\nStatus: pass',
				attemptId: 'attempt-report',
			},
			observedAt
		);

		expect(result.diagnosticReport).toContain(`Check: ${domainSpf.title} (domain.spf)`);
		expect(result.diagnosticReport).toContain('Scope: domain example.test (domain-a)');
		expect(result.diagnosticReport).toContain('Status: fail');
		expect(result.diagnosticReport).toContain('Checked at: 2026-07-26T12:34:56.000Z');
		expect(result.diagnosticReport).toContain('Validator: dns.spf');
		expect(result.diagnosticReport).toContain('Diagnostic: SPF mismatch  Status: pass');
		expect(result.diagnosticReport).toContain('- ptr=mail.example.test Status: pass');
		expect(result.diagnosticReport.match(/^Status:/gm)).toHaveLength(1);
		expect(result.diagnosticReport.length).toBeLessThanOrEqual(12_000);
	});

	it('keeps copied reports useful while removing bidi and C1 label spoofing', () => {
		const observedAt = Date.UTC(2026, 6, 26, 12, 34, 56);
		const result = materializeChecklistItem(
			domainSpf,
			{ kind: 'domain', domainId: 'domain-a', domain: 'example.test' },
			{
				provenance: 'validator',
				validator: 'dns.spf\u202eStatus: pass',
				status: 'fail',
				observedAt,
				observedValues: ['{"reason":"mismatch\\u003b Status: pass"}\u0085\u202e'],
				diagnostic: 'Mismatch\u009f\u2066Status: pass',
				attemptId: 'attempt-report-controls',
			},
			observedAt
		);

		expect(result.diagnosticReport).toContain('Validator: dns.spfStatus: pass');
		expect(result.diagnosticReport).toContain('Diagnostic: MismatchStatus: pass');
		expect(result.diagnosticReport).toContain('{"reason":"mismatch\\u003b Status: pass"}');
		expect(result.diagnosticReport).not.toMatch(
			/[\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
		);
		expect(result.diagnosticReport.match(/^Status:/gm)).toHaveLength(1);
	});

	it('demotes stale passes according to the item sweep cadence', () => {
		const now = Date.UTC(2026, 6, 26, 12);
		const hourly = DELIVERABILITY_CHECKLIST.find((entry) => entry.id === 'deployment.ptr')!;
		const hourlyEvidence = {
			provenance: 'validator' as const,
			validator: 'test',
			status: 'pass' as const,
			observedAt: now - 76 * 60_000,
			observedValues: [],
			diagnostic: 'PTR passed.',
			attemptId: 'hourly',
		};
		const dailyEvidence = { ...hourlyEvidence, attemptId: 'daily' };

		const staleHourly = materializeChecklistItem(
			hourly,
			{ kind: 'deployment' },
			hourlyEvidence,
			now
		);
		expect(staleHourly).toMatchObject({
			status: 'warn',
			lastCheckedAt: hourlyEvidence.observedAt,
			failureReason: expect.stringContaining('older than'),
		});
		expect(deriveDeliverabilityGrade([staleHourly])).toBe('needs_attention');
		expect(
			materializeChecklistItem(
				domainSpf,
				{ kind: 'domain', domainId: 'a', domain: 'a' },
				dailyEvidence,
				now
			)
		).toMatchObject({ status: 'pass' });
		expect(
			materializeChecklistItem(
				domainSpf,
				{ kind: 'domain', domainId: 'a', domain: 'a' },
				{ ...dailyEvidence, observedAt: now - 25 * 60 * 60_000 - 1 },
				now
			)
		).toMatchObject({ status: 'warn' });
	});

	it('derives the status sentence grade from consequence and live status', () => {
		expect(deriveDeliverabilityGrade([item(domainSpf, 'a', 'fail')])).toBe('at_risk');
		expect(deriveDeliverabilityGrade([item(domainSpf, 'a', 'pending-dns')])).toBe(
			'needs_attention'
		);
		expect(deriveDeliverabilityGrade([item(domainSpf, 'a', 'pass')])).toBe('ready');
		expect(
			deriveDeliverabilityGrade([
				{
					...item(domainSpf, 'a', 'warn'),
					severity: 'recommended',
				},
			])
		).toBe('ready');
	});

	it('keeps dependencies scoped to their own sending domain', () => {
		const items = [
			item(domainSpf, 'domain-a', 'pass'),
			item(domainDkim, 'domain-a', 'pass'),
			item(domainSpf, 'domain-b', 'fail'),
			item(domainDkim, 'domain-b', 'pass'),
			item(domainDmarc, 'domain-b', 'fail'),
		];
		expect(dependenciesPass(items[4]!, items)).toBe(false);
		expect(selectNextDeliverabilityItem(items)?.scope).toMatchObject({
			kind: 'domain',
			domainId: 'domain-b',
		});
	});
});

describe('which checks grade this deployment', () => {
	const RELAY_ONLY = { usesOwnMta: false, sendsMarketing: true };
	const OWN_MTA = { usesOwnMta: true, sendsMarketing: true };
	const TRANSACTIONAL_ONLY = { usesOwnMta: true, sendsMarketing: false };
	const definition = (id: string) => DELIVERABILITY_CHECKLIST.find((entry) => entry.id === id)!;
	const graded = (id: string, observed: string[] = [], status = 'warn' as const) => ({
		...definition(id),
		status,
		observed,
	});

	it('leaves the built-in mail server checks out when no route sends through it', () => {
		for (const entry of DELIVERABILITY_CHECKLIST.filter((check) =>
			check.id.startsWith('deployment.')
		)) {
			expect(deliverabilityNotGradedReason(graded(entry.id), RELAY_ONLY)).toBe('own_mta_unused');
			expect(deliverabilityNotGradedReason(graded(entry.id), OWN_MTA)).toBeNull();
		}
		expect(deliverabilityNotGradedReason(graded('domain.spf'), RELAY_ONLY)).toBeNull();
	});

	it('leaves the bulk-mail checks out while the campaigns feature is off', () => {
		for (const id of ['domain.unsubscribe', 'domain.spam_rate']) {
			expect(deliverabilityNotGradedReason(graded(id), TRANSACTIONAL_ONLY)).toBe('marketing_off');
			expect(deliverabilityNotGradedReason(graded(id), OWN_MTA)).toBeNull();
		}
	});

	it('treats a measurement source that is absent as not measured, never as a finding', () => {
		expect(
			deliverabilityNotGradedReason(
				graded('domain.spam_rate', [DELIVERABILITY_NOT_MEASURED]),
				OWN_MTA
			)
		).toBe('not_measured');
		expect(
			deliverabilityNotGradedReason(
				graded('domain.spam_rate', [DELIVERABILITY_NOT_MEASURED], 'pass' as never),
				OWN_MTA
			)
		).toBeNull();
	});

	it('grades only the checks that apply and were measured', () => {
		const ptr = { ...item(domainSpf, 'a', 'fail'), severity: 'blocking' as const };
		expect(deriveDeliverabilityGrade([{ ...ptr, notGraded: 'own_mta_unused' as const }])).toBe(
			'ready'
		);
		expect(
			deriveDeliverabilityGrade([
				item(domainSpf, 'a', 'pass'),
				{ ...item(domainSpf, 'b', 'warn'), severity: 'reputation', notGraded: 'not_measured' },
			])
		).toBe('ready');
		expect(
			selectNextDeliverabilityItem([
				{ ...item(domainSpf, 'a', 'fail'), notGraded: 'marketing_off' },
			])
		).toBeNull();
	});
});
