/**
 * Sending-domains page wiring. The Add-Domain modal body is the standalone
 * DomainsAddDomainForm (covered by real mounts in addDomainForm.test.ts), the
 * DNS guidance banner is DomainDnsGuidance (DomainDnsGuidance.test.ts) and the
 * outbound-IP panel is SendingDetails (SendingDetails.test.ts). `domains.vue`
 * itself is Convex-query driven and awkward to mount, so what is pinned here is
 * only what lives on the page: which components it embeds, and in which order.
 */
import { describe, it, expect } from 'vitest';
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
		// Both are catalog lookups since the extraction; the ORDER on the page is
		// what this pins, so the anchors are the keypaths the page renders.
		const h1 = pageSource.indexOf("t('dashboard.admin.delivery.domains.title')");
		const whyCard = pageSource.indexOf("t('dashboard.admin.delivery.domains.whyCustom.title')");
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

describe('Outbound identity status on the domains surface', () => {
	it('mounts the outbound-IP panel from the page overview query', () => {
		expect(pageSource).toMatch(
			/<DeliverySendingDetails[\s\S]*?:warming="outboundIpDetail\.warming"/
		);
	});
});
