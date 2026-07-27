import { describe, expect, it } from 'vitest';
import { evaluateIpAudit, type IpAuditZoneObservation } from '../ipAudit';
import {
	delistingGuidanceFor,
	delistingGuidanceForFindings,
	type DelistingContext,
} from '../ipAuditDelisting';

const CONTEXT: DelistingContext = {
	ip: '198.51.100.7',
	ehlo: 'mail.example.com',
	contactEmail: 'postmaster@example.com',
};

describe('zone-specific removal guidance', () => {
	it('gives PBL, CSS, SBL and XBL different URLs and different advice', () => {
		const pbl = delistingGuidanceFor({ zoneId: 'spamhaus', sublist: 'pbl' }, CONTEXT);
		const css = delistingGuidanceFor({ zoneId: 'spamhaus', sublist: 'css' }, CONTEXT);
		const sbl = delistingGuidanceFor({ zoneId: 'spamhaus', sublist: 'sbl' }, CONTEXT);
		const xbl = delistingGuidanceFor({ zoneId: 'spamhaus', sublist: 'xbl' }, CONTEXT);

		const urls = [pbl, css, sbl, xbl].map((entry) => entry.removalUrl);
		expect(new Set(urls).size).toBe(4);
		const causes = [pbl, css, sbl, xbl].map((entry) => entry.likelyCause);
		expect(new Set(causes).size).toBe(4);
		const requests = [pbl, css, sbl, xbl].map((entry) => entry.prefilledRequest);
		expect(new Set(requests).size).toBe(4);
	});

	it('marks the self-service zones and the reviewed ones honestly', () => {
		expect(delistingGuidanceFor({ zoneId: 'spamhaus', sublist: 'pbl' }, CONTEXT).selfService).toBe(
			true
		);
		expect(delistingGuidanceFor({ zoneId: 'spamhaus', sublist: 'sbl' }, CONTEXT).selfService).toBe(
			false
		);
		expect(delistingGuidanceFor({ zoneId: 'spamhaus', sublist: 'drop' }, CONTEXT).selfService).toBe(
			false
		);
	});

	it('tells the operator plainly that a PBL listing is not their fault', () => {
		const pbl = delistingGuidanceFor({ zoneId: 'spamhaus', sublist: 'pbl' }, CONTEXT);
		expect(pbl.likelyCause).toMatch(/nothing you sent/i);
		expect(pbl.removalUrl).toContain('pbl');
	});

	it('differs for a non-Spamhaus zone', () => {
		const barracuda = delistingGuidanceFor({ zoneId: 'barracuda' }, CONTEXT);
		const sorbs = delistingGuidanceFor({ zoneId: 'sorbs' }, CONTEXT);
		expect(barracuda.key).toBe('barracuda');
		expect(barracuda.removalUrl).toContain('barracudacentral.org');
		expect(sorbs.removalUrl).toContain('sorbs.net');
		expect(barracuda.likelyCause).not.toBe(sorbs.likelyCause);
		expect(barracuda.label).not.toBe(sorbs.label);
	});
});

describe('likely cause from our own metrics', () => {
	it('names the complaint rate when complaints are elevated', () => {
		const guidance = delistingGuidanceFor(
			{ zoneId: 'spamcop' },
			{ ...CONTEXT, metrics: { complaintPct: 0.42, hardBouncePct: 0.1 } }
		);
		expect(guidance.likelyCause).toContain('0.42%');
		expect(guidance.likelyCause).toMatch(/complaint/i);
	});

	it('names the bounce rate when bounces are the elevated signal', () => {
		const guidance = delistingGuidanceFor(
			{ zoneId: 'barracuda' },
			{ ...CONTEXT, metrics: { complaintPct: 0.01, hardBouncePct: 6 } }
		);
		expect(guidance.likelyCause).toContain('6%');
		expect(guidance.likelyCause).toMatch(/bounce/i);
	});

	it('names the volume spike for a ramp-driven zone', () => {
		const guidance = delistingGuidanceFor(
			{ zoneId: 'spamhaus', sublist: 'css' },
			{ ...CONTEXT, metrics: { volumeRampMultiplier: 8 } }
		);
		expect(guidance.likelyCause).toContain('x8');
	});

	it('falls back to the zone default when we have no metrics at all', () => {
		const withMetrics = delistingGuidanceFor(
			{ zoneId: 'spamcop' },
			{ ...CONTEXT, metrics: { complaintPct: 0.9 } }
		);
		const without = delistingGuidanceFor({ zoneId: 'spamcop' }, CONTEXT);
		expect(without.likelyCause).not.toBe(withMetrics.likelyCause);
		expect(without.likelyCause.length).toBeGreaterThan(0);
	});
});

describe('pre-filled request', () => {
	it('carries the address, the sending hostname and the contact', () => {
		const guidance = delistingGuidanceFor({ zoneId: 'spamhaus', sublist: 'sbl' }, CONTEXT);
		expect(guidance.prefilledRequest).toContain('198.51.100.7');
		expect(guidance.prefilledRequest).toContain('mail.example.com');
		expect(guidance.prefilledRequest).toContain('postmaster@example.com');
	});

	it('includes our own measurements when we have them', () => {
		const guidance = delistingGuidanceFor(
			{ zoneId: 'spamhaus', sublist: 'sbl' },
			{ ...CONTEXT, metrics: { sends24h: 1200, hardBouncePct: 1.5, complaintPct: 0.05 } }
		);
		expect(guidance.prefilledRequest).toContain('1200 messages');
		expect(guidance.prefilledRequest).toContain('hard bounce rate 1.5%');
		expect(guidance.prefilledRequest).toContain('complaint rate 0.05%');
	});

	it('omits the measurements block entirely when there is nothing to report', () => {
		const guidance = delistingGuidanceFor({ zoneId: 'spamhaus', sublist: 'sbl' }, CONTEXT);
		expect(guidance.prefilledRequest).not.toContain('Current measurements');
	});
});

describe('guidance derived from an audit report', () => {
	function zone(
		zoneId: IpAuditZoneObservation['zoneId'],
		sublists: IpAuditZoneObservation['sublists']
	): IpAuditZoneObservation {
		return { zoneId, status: 'listed', sublists, answers: [] };
	}

	it('produces one entry per distinct listing and none for a clean audit', () => {
		const listed = evaluateIpAudit({
			ip: '198.51.100.7',
			checkedAt: 1,
			port25: 'open',
			zones: [zone('spamhaus', ['css', 'pbl']), zone('spamcop', [])],
			fcrdns: { verdict: 'pass' },
			neighbourhood: { sampled: 16, listed: 0 },
		});
		const guidance = delistingGuidanceForFindings(listed.findings, CONTEXT);
		expect(guidance.map((entry) => entry.key)).toEqual(['spamhaus:css', 'spamhaus:pbl', 'spamcop']);

		const clean = evaluateIpAudit({
			ip: '198.51.100.7',
			checkedAt: 1,
			port25: 'open',
			zones: [{ zoneId: 'spamhaus', status: 'clean', sublists: [], answers: [] }],
			fcrdns: { verdict: 'pass' },
			neighbourhood: { sampled: 16, listed: 0 },
		});
		expect(delistingGuidanceForFindings(clean.findings, CONTEXT)).toEqual([]);
	});

	it('never offers a removal form for an incomplete audit', () => {
		const report = evaluateIpAudit({
			ip: '198.51.100.7',
			checkedAt: 1,
			port25: 'unknown',
			zones: [{ zoneId: 'spamhaus', status: 'unknown', sublists: [], answers: [] }],
			fcrdns: { verdict: 'error' },
			neighbourhood: { sampled: 0, listed: 0 },
		});
		expect(delistingGuidanceForFindings(report.findings, CONTEXT)).toEqual([]);
	});
});
