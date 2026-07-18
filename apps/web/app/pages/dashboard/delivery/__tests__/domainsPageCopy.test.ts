// @vitest-environment happy-dom
/**
 * Sending-domains page — pieces B2 + C2 of the DNS Setup Revamp.
 *
 * B2 demoted the per-transport DNS guidance banner below the "Why add a custom
 * domain?" card. C2 extracted the Add-Domain modal body into the standalone
 * DomainsAddDomainForm component — so the modal-copy behaviour (live preview,
 * apex, freemail, paste round-trip) is now covered by REAL MOUNTS in
 * addDomainForm.test.ts, and this file only pins what still lives on the page:
 * the banner ordering and the modal's delegation to the form component.
 *
 * `domains.vue` is Convex-query driven (a dozen composables + a page-meta/head
 * call at module scope) and awkward to mount in happy-dom, so — exactly as the
 * knowledge-graph and empty-state page guards do — we assert the load-bearing
 * template facts against the source. The behavioural half we CAN mount cheaply
 * (the guidance component) is exercised directly, so the ordering assertion is
 * anchored to the real transport banner it moves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(here, '../domains.vue'), 'utf8');

describe('Add-Domain modal — delegated to the guided form component', () => {
	it('renders the extracted form inside the modal, passing loading + wiring submit/cancel', () => {
		expect(pageSource).toMatch(
			/<UiModal[\s\S]*?<DomainsAddDomainForm[\s\S]*?:loading="addModal\.isLoading\.value"[\s\S]*?@submit="handleAddDomain"[\s\S]*?@cancel="addModal\.close\(\)"/
		);
	});

	it('no longer inlines the old single free-text modal body', () => {
		// The bare inline field + its state left with the extraction.
		expect(pageSource).not.toContain('v-model="addForm.domain"');
		expect(pageSource).not.toContain('data-testid="address-preview"');
	});

	it('delegates the add-domain orchestration to the useAddDomain flow', () => {
		// The atomic create-with-host orchestration lives in the tested composable;
		// the page just wires its mutation run / modal / toast into it. The
		// return-path host is folded into `create` (F2 finding 1), so the page no
		// longer wires a separate `setReturnPathHost` op into the add flow.
		expect(pageSource).toMatch(/const \{ handleAddDomain \} = useAddDomain\(\{/);
		expect(pageSource).toContain('createDomain,');
	});
});

describe('Page ordering — mental model before transports', () => {
	it('places the "Why add a custom domain?" card before the DNS guidance banner', () => {
		const h1 = pageSource.indexOf('Sending Domains</h1>');
		const whyCard = pageSource.indexOf('Why add a custom domain?');
		const guidance = pageSource.indexOf('<DeliveryDomainDnsGuidance');
		expect(h1).toBeGreaterThan(-1);
		expect(whyCard).toBeGreaterThan(-1);
		expect(guidance).toBeGreaterThan(-1);
		// First thing under the h1 is the why-card; the transport banner follows it.
		expect(whyCard).toBeGreaterThan(h1);
		expect(guidance).toBeGreaterThan(whyCard);
	});

	it('renders the guidance banner exactly once (moved, not duplicated)', () => {
		const matches = pageSource.match(/<DeliveryDomainDnsGuidance/g) ?? [];
		expect(matches).toHaveLength(1);
	});

	it('places the banner as a SIBLING of the info card, not nested inside it', () => {
		// The banner sits at the content wrapper's indentation (3 tabs), the same
		// level as the tinted info card — not one deeper (4 tabs), which would be
		// the card-inside-card on a tinted background the reviewer flagged.
		expect(pageSource).toMatch(/\n\t\t\t<DeliveryDomainDnsGuidance \/>/);
		expect(pageSource).not.toMatch(/\n\t\t\t\t<DeliveryDomainDnsGuidance/);
		// And it lands after the info card's tinted wrapper has closed.
		const infoCard = pageSource.indexOf('card p-6 bg-brand/5');
		const guidance = pageSource.indexOf('<DeliveryDomainDnsGuidance');
		const cardClose = pageSource.indexOf('</div>\n\n\t\t\t<!-- Per-transport DNS guidance');
		expect(cardClose).toBeGreaterThan(infoCard);
		expect(guidance).toBeGreaterThan(cardClose);
	});
});

// The demoted marker is the real per-transport banner — mount it to anchor the
// ordering assertion above to what actually renders ("DNS for <transport>").
vi.stubGlobal('useOrganizationQuery', () => ({ data: ref({ provider: 'mta' }) }));

import DomainDnsGuidance from '../../../../components/delivery/DomainDnsGuidance.vue';

describe('DomainDnsGuidance — the banner being demoted', () => {
	beforeEach(() => {
		vi.stubGlobal('useOrganizationQuery', () => ({ data: ref({ provider: 'mta' }) }));
	});

	it('renders the transport DNS banner for the active provider', () => {
		const w = mount(DomainDnsGuidance, {
			global: {
				stubs: {
					Icon: { template: '<i />' },
					UiCard: { template: '<div><slot /></div>' },
				},
			},
		});
		expect(w.text()).toContain('DNS for Owlat mail server');
	});

	it('renders nothing when the transport is unknown', () => {
		vi.stubGlobal('useOrganizationQuery', () => ({ data: ref(null) }));
		const w = mount(DomainDnsGuidance, {
			global: {
				stubs: {
					Icon: { template: '<i />' },
					UiCard: { template: '<div><slot /></div>' },
				},
			},
		});
		expect(w.find('div').exists()).toBe(false);
	});
});
