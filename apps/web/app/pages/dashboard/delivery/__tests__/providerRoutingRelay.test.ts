/**
 * The relay-identity panel's PAGE WIRING and its two source-level invariants.
 *
 * WHAT THIS FILE USED TO BE: a grep over an SES-shaped panel — `SES status: {{
 * domain.status }}`, `domain.spfProofState === 'not_applicable_manual_primary'`,
 * "Apex SPF: not applicable to SES relay proof". Every one of those strings was
 * downstream of a query that point-read the frozen `sendingDomainSesIdentities`
 * sibling, and pinning them was pinning the coupling. The rendering cases moved
 * to `components/delivery/__tests__/RelayDomainStatus.test.ts`, which mounts the
 * component against rows of three different kinds rather than reading its source.
 *
 * WHAT IS LEFT IS WHAT ONLY A SOURCE READ CAN SAY: that the three delivery pages
 * embed the panel as one tag, that its safety prose about the operator's
 * existing SPF record survives an edit, and that NO KIND LITERAL comes back.
 * That last one is the guard that replaces `ANSWERS_FOR_KINDS = ['ses']` — a
 * panel that starts asking which vendor it is looking at is a panel whose query
 * has stopped answering for all of them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
	resolve(here, '../../../../components/delivery/RelayDomainStatus.vue'),
	'utf8'
);
const page = (name: string): string => readFileSync(resolve(here, `../${name}`), 'utf8');

describe('the relay-identity panel on the delivery pages', () => {
	it.each(['provider-routing.vue', 'domains.vue', 'migrate.vue'])(
		'is embedded in %s as one self-querying tag',
		(name) => {
			expect(page(name)).toContain('<DeliveryRelayDomainStatus />');
		}
	);

	it('loads the kind-agnostic relay-domain query and wires the existing DNS verifier', () => {
		expect(source).toContain('api.providerRoutes.listRelayDomainIdentities');
		expect(source).toContain('api.domains.dnsVerification.verifyDomain');
		expect(source).toMatch(/verifyRelayDomain\(\{ domainId \}\)/);
		expect(source).toContain('usePaginatedQuery');
		expect(source).toContain('Load more domains');
		expect(source).not.toContain('Showing the first 512 owned-MTA domains');
	});

	it('states the merged-SPF and unchanged-DMARC requirements without claiming instant readiness', () => {
		expect(source).toContain('preserve your');
		expect(source).toContain('never replace it with a');
		expect(source).not.toContain('replaces the existing SPF record');
		expect(source).toContain('Your primary DMARC record remains unchanged');
	});

	it('asks no question about WHICH provider it is rendering', () => {
		// The one permitted mention of a kind is the per-kind copy map, which is
		// keyed by kind and colocated with the markup it feeds — the
		// `SignedWebhookCard.vue` pattern. What must not come back is a gate: a
		// kind compared, or a set of kinds the panel believes it can speak for.
		// The DECLARATION, not the mention: the file's header explains at length
		// what `ANSWERS_FOR_KINDS` was and why the generic read retired it, and
		// that paragraph is the reason nobody reintroduces it.
		expect(source).not.toMatch(/const ANSWERS_FOR_KINDS/);
		expect(source).not.toMatch(/kind\s*===\s*'/);
		expect(source).not.toMatch(/\.includes\((?:entry\.)?row?\.?kind\)/);
		// Labels come from the row, never from a literal beside it.
		expect(source).toContain('kindLabel');
	});
});
