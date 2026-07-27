// @vitest-environment happy-dom
/**
 * The wizard's step 3 — SPF/DKIM/DMARC alignment against LIVE DNS fixtures.
 *
 * The wizard does NOT own a second detector: it gathers TXT over the shipped
 * DNS-over-HTTPS helper and runs the shipped `evaluateAlignmentPreflight`, which
 * runs the shipped `evaluateSpfCoexistence` including its RFC 7208 10-lookup
 * accounting. These cases pin what an OPERATOR sees for each way the pair of
 * arms can be misconfigured — every failure has to name the exact DNS change to
 * make, because a verdict without a remedy is a dead end.
 *
 * Cases: aligned; a misaligned From domain; a missing relay include; a record
 * that exceeds the 10-lookup limit once the relay include is merged in (which
 * must name the include to flatten); a missing DKIM selector; and DMARC that
 * does not align. Plus the two states that must never be laundered into a
 * verdict: an unresolvable lookup, and no reference transport at all (D2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlignmentCheckId } from '@owlat/shared/deliverabilityAlignment';
import { runAlignmentProbe } from '~/utils/transportAlignmentProbe';
import { alignmentFindings, type WizardFinding } from '~/utils/transportWizard';
import { ALIGNED_DNS, OWN_ARM, referenceArm, stubDoh, type TxtFixture } from './wizardHarness';

async function probe(
	dns: TxtFixture,
	reference = referenceArm(),
	ownArm: Parameters<typeof runAlignmentProbe>[0] = OWN_ARM
) {
	stubDoh(dns);
	const result = await runAlignmentProbe(ownArm, reference, 1_700_000_000_000);
	return { result, findings: alignmentFindings(result) };
}

function finding(findings: readonly WizardFinding[], id: AlignmentCheckId): WizardFinding {
	const row = findings.find((candidate) => candidate.id === id);
	if (!row) throw new Error(`No ${id} finding was produced`);
	return row;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('wizard alignment — live DNS', () => {
	it('passes every check when one SPF record covers both arms', async () => {
		const { result, findings } = await probe(ALIGNED_DNS);
		expect(result.verdict).toBe('aligned');
		expect(findings.map((row) => row.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
		expect(finding(findings, 'spf').detail).toContain('of 10 DNS lookups used');
		expect(findings.every((row) => row.remedy === null)).toBe(true);
	});

	it('blocks a per-transport From domain and says to use per-stream subdomains', async () => {
		const { result, findings } = await probe(
			ALIGNED_DNS,
			referenceArm({ fromDomain: 'mail.example.com' })
		);
		expect(result.verdict).toBe('blocked');
		const row = finding(findings, 'from_domain');
		expect(row.status).toBe('fail');
		expect(row.remedy).toContain('same From domain');
		expect(row.remedy).toContain('per-stream subdomains');
	});

	it('names the relay include that the published SPF record is missing', async () => {
		const { result, findings } = await probe({
			...ALIGNED_DNS,
			'example.com': ['v=spf1 ip4:203.0.113.10 ~all'],
		});
		expect(result.verdict).toBe('blocked');
		const row = finding(findings, 'spf');
		expect(row.status).toBe('fail');
		expect(row.detail).toContain('include:amazonses.com');
		expect(row.remedy).toContain('Missing: include:amazonses.com');
		// Never "publish a second record" — RFC 7208 allows exactly one.
		expect(row.remedy).toContain('instead of publishing a second record');
	});

	it('fails loudly past the 10-lookup limit and names the include to flatten', async () => {
		const crowded = [
			'v=spf1 ip4:203.0.113.10 include:amazonses.com',
			'include:a.example.net include:b.example.net include:c.example.net',
			'include:d.example.net include:e.example.net include:f.example.net',
			'include:g.example.net include:h.example.net include:i.example.net',
			'include:legacy.example.net ~all',
		].join(' ');
		const { result, findings } = await probe({ ...ALIGNED_DNS, 'example.com': [crowded] });
		expect(result.verdict).toBe('blocked');
		const row = finding(findings, 'spf');
		expect(row.status).toBe('fail');
		expect(row.detail).toContain('11 DNS lookups');
		expect(row.remedy).toContain('exceeds the RFC 7208 10-lookup limit');
		expect(row.remedy).toContain('Flatten include:legacy.example.net');
		// The two arms' own mechanisms are never proposed for flattening.
		expect(row.remedy).not.toContain('Flatten include:amazonses.com');
	});

	it('fails a missing DKIM selector at the exact record name to publish', async () => {
		const dns = { ...ALIGNED_DNS };
		delete dns['ses1._domainkey.example.com'];
		const { result, findings } = await probe(dns);
		expect(result.verdict).toBe('blocked');
		const row = finding(findings, 'dkim');
		expect(row.status).toBe('fail');
		expect(row.detail).toContain('ses1._domainkey.example.com');
		expect(row.remedy).toContain('Publish the DKIM public key');
	});

	it('fails DMARC when a strict policy cannot align both arms', async () => {
		const own = { ...OWN_ARM, dkimDomain: 'mail.example.com' };
		const { result, findings } = await probe(
			{
				'example.com': ['v=spf1 ip4:203.0.113.10 include:amazonses.com ~all'],
				'_dmarc.example.com': ['v=DMARC1; p=reject; adkim=s'],
				'owlat._domainkey.mail.example.com': ['v=DKIM1; k=rsa; p=OWNKEY'],
				'ses1._domainkey.mail.example.com': ['v=DKIM1; k=rsa; p=RELAYKEY'],
			},
			referenceArm({ dkimDomain: 'mail.example.com' }),
			own
		);
		expect(result.verdict).toBe('blocked');
		const dmarc = finding(findings, 'dmarc');
		expect(dmarc.status).toBe('fail');
		expect(dmarc.remedy).toContain('adkim=s');
		// The DKIM pair itself is fine — only the strict policy is the problem.
		expect(finding(findings, 'dkim').status).toBe('pass');
	});

	it('reports an unresolvable lookup as unknown, never as aligned and never as a failure', async () => {
		const { result, findings } = await probe({ ...ALIGNED_DNS, 'example.com': 'servfail' });
		expect(result.verdict).toBe('unknown');
		const row = finding(findings, 'spf');
		expect(row.status).toBe('unknown');
		expect(row.detail).toContain('servfail');
	});

	it('passes trivially with no reference transport — absence is supported (D2)', async () => {
		stubDoh(ALIGNED_DNS);
		const result = await runAlignmentProbe(OWN_ARM, { kind: 'none' }, 1_700_000_000_000);
		expect(result.verdict).toBe('single_arm');
		expect(alignmentFindings(result).every((row) => row.status === 'pass')).toBe(true);
		expect(result.isMeasurementDegraded).toBe(false);
	});

	it('records a relay that cannot carry our return path as degraded, not blocked', async () => {
		const { result } = await probe(ALIGNED_DNS, referenceArm({ supportsCustomReturnPath: false }));
		expect(result.verdict).toBe('aligned');
		expect(result.isMeasurementDegraded).toBe(true);
		expect(result.measurementDegradedReason).toContain('not blocked');
	});
});
