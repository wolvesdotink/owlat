import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Docs-lint for DNS / email setup (audit item PR-66).
 *
 * The self-hosting DNS doc used to tell operators to openssl-generate a DKIM
 * key at selector `s1` and set `DKIM_KEYS`, while the in-app Add-domain flow
 * generates its own key (selector `s{timestamp}`) and overwrites the Redis key.
 * Following the doc then clicking Add Domain broke DKIM. The doc also promised
 * an `ip4` SPF record even though the built-in MTA only emits SPF when
 * `MTA_SPF_INCLUDE` is set.
 *
 * These assertions keep the docs honest against the actual generation code in
 * `apps/api/convex/domains/providers/mta/index.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const dnsDoc = readFileSync(
	resolve(repoRoot, 'apps/docs/content/3.developer/32.self-hosting-dns-email.md'),
	'utf8',
);
const mtaProvider = readFileSync(
	resolve(repoRoot, 'apps/api/convex/domains/providers/mta/index.ts'),
	'utf8',
);
const mtaEnvExample = readFileSync(resolve(repoRoot, 'apps/mta/.env.example'), 'utf8');

describe('DNS doc: single DKIM path (PR-66)', () => {
	it('describes the in-app Add-domain DKIM generation flow', () => {
		expect(dnsDoc).toMatch(/Add domain/i);
		// The MTA assigns a timestamp-based selector, not a fixed s1.
		expect(dnsDoc).toMatch(/s\{timestamp\}/);
	});

	it('does NOT present hand-rolled openssl key generation as the DKIM path', () => {
		const dkimSection = dnsDoc.slice(
			dnsDoc.indexOf('## DKIM'),
			dnsDoc.indexOf('## DMARC'),
		);
		expect(dkimSection.length).toBeGreaterThan(0);
		// The old contradictory instruction was `openssl genrsa` to make the key.
		expect(dkimSection).not.toMatch(/openssl genrsa/);
	});

	it('explains that DKIM_KEYS is migration-only and must not race the in-app flow', () => {
		expect(dnsDoc).toMatch(/DKIM_KEYS/);
		// The doc must warn that the in-app flow overwrites the Redis key, so the
		// two paths must not be combined for the same domain.
		expect(dnsDoc).toMatch(/overwrite|clobber|never overwrites|migrat/i);
	});
});

describe('DNS doc: SPF guidance matches code (PR-66)', () => {
	const spfSection = dnsDoc.slice(dnsDoc.indexOf('## SPF'), dnsDoc.indexOf('## DKIM'));

	it('SPF section exists and is non-trivial', () => {
		expect(spfSection.length).toBeGreaterThan(0);
	});

	it('states the built-in MTA only emits SPF when MTA_SPF_INCLUDE is set', () => {
		// The generation code gates SPF on MTA_SPF_INCLUDE...
		expect(mtaProvider).toMatch(/MTA_SPF_INCLUDE/);
		// ...so the doc must name that env var in its SPF guidance.
		expect(spfSection).toMatch(/MTA_SPF_INCLUDE/);
	});

	it('tells operators to add an ip4 SPF record manually when no record is generated', () => {
		expect(spfSection).toMatch(/v=spf1 ip4:/);
		expect(spfSection).toMatch(/manual/i);
	});

	it('keeps the include: form consistent with the value the code emits', () => {
		// Code builds the SPF record via the shared `buildSpfRecordValue` helper,
		// passing the MTA_SPF_INCLUDE value as the `include:` mechanism — which
		// emits `v=spf1 include:<spfInclude> ~all` (default soft-fail qualifier).
		expect(mtaProvider).toMatch(/buildSpfRecordValue\(\{\s*include:\s*spfInclude/);
		// Doc must show the include: form too (for the MTA_SPF_INCLUDE path).
		expect(spfSection).toMatch(/v=spf1 include:/);
	});
});

/**
 * Docs-lint for the single-IP EHLO/PTR posture (audit item PR-64).
 *
 * EHLO/banner/PTR consistency is the cornerstone of the 2024 Gmail/Yahoo
 * bulk-sender rules (RFC 5321 §4.1.1.1 / §4.2): the EHLO name and the SMTP
 * banner must be a real FQDN that matches the sending IP's reverse-DNS PTR
 * record. The self-hosting DNS doc must therefore tell operators how to set and
 * verify that PTR record, and the MTA env example must keep the comment that
 * pins EHLO_HOSTNAME to the rDNS PTR record. These assertions keep that guidance
 * from silently regressing out of the docs.
 */
describe('DNS doc: PTR / reverse-DNS guidance (PR-64)', () => {
	it('has a PTR / Reverse DNS heading', () => {
		// A markdown heading (any level) naming PTR and/or Reverse DNS.
		expect(dnsDoc).toMatch(/^#{1,6}\s+.*\b(PTR|Reverse DNS)\b/im);
	});

	it('shows how to verify the PTR record with `dig -x`', () => {
		expect(dnsDoc).toMatch(/dig -x/);
	});

	it('notes the PTR record is set through the hosting provider (not the DNS provider)', () => {
		// The PTR record lives with the IP owner — the hosting/cloud provider —
		// not the authoritative DNS provider; operators routinely look in the
		// wrong place, so the doc must call this out explicitly.
		const ptrSection = dnsDoc.slice(
			dnsDoc.search(/^#{1,6}\s+.*\b(PTR|Reverse DNS)\b/im),
		);
		expect(ptrSection).toMatch(/hosting provider/i);
	});
});

describe('MTA env example: EHLO_HOSTNAME ↔ PTR comment (PR-64)', () => {
	it('keeps the comment pinning EHLO_HOSTNAME to the rDNS PTR record', () => {
		// The comment must survive next to the EHLO_HOSTNAME key so operators
		// editing the env file see the PTR requirement inline.
		expect(mtaEnvExample).toMatch(/EHLO_HOSTNAME=/);
		expect(mtaEnvExample).toMatch(/must match the rDNS PTR record/i);
	});
});
