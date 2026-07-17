// @vitest-environment happy-dom
/**
 * Sending-domains page copy — piece B2 of the DNS Setup Revamp.
 *
 * Two facts are pinned here:
 *   1. The Add-Domain modal states the CONSEQUENCE of the entered domain via a
 *      LIVE `you@<domain>` preview that updates as the user types, with a
 *      sensible empty state — not a bare "enter a domain" hint.
 *   2. The per-transport DNS guidance banner is DEMOTED below the "Why add a
 *      custom domain?" card, so the first thing under the h1 builds the mental
 *      model instead of naming transports.
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

describe('Add-Domain modal — live address preview', () => {
	it('drops the bare "enter a domain" hint for a consequence-stating one', () => {
		expect(pageSource).not.toContain('Enter the domain you want to use for sending emails');
	});

	it('renders a live you@<domain> preview bound to the typed field', () => {
		// The preview element interpolates the reactive `previewDomain` computed
		// into a `you@…` address — a data binding, so it is not a static string.
		const preview = pageSource.match(
			/data-testid="address-preview"[\s\S]*?you@\{\{\s*previewDomain[\s\S]*?<\/p>/
		);
		expect(preview).not.toBeNull();
	});

	it('derives the preview reactively from the v-model field, so typing updates it', () => {
		// `previewDomain` is computed off `addForm.domain` — the same reactive
		// target the input's v-model writes — so each keystroke re-renders it.
		expect(pageSource).toMatch(/const previewDomain = computed\(\(\) => addForm\.domain/);
		expect(pageSource).toContain('v-model="addForm.domain"');
	});

	it('falls back to the example domain when the field is empty (sensible empty state)', () => {
		expect(pageSource).toContain("previewDomain || 'mail.example.com'");
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
