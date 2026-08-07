// @vitest-environment happy-dom
/**
 * WHO SEES THE SES ESCAPE-HATCH CARD — the component's own wiring.
 *
 * `utils/__tests__/relayIdentityPanel.test.ts` pins the predicate; this pins the
 * three inputs the component feeds it, because each is a decision that a later
 * edit could reverse with the predicate's suite still green:
 *
 *  - the CONFIGURED KINDS come from `listRoutes` → `deliverabilityFallback.
 *    relayProviderType`, and the flatMap deliberately IGNORES `isEnabled`:
 *    publishing a relay's DNS is what an operator does BEFORE switching the
 *    hatch on, so filtering on it would hide the records from exactly the
 *    operator who is mid-setup;
 *  - the ANSWERING SET is `['ses']`, because the query reads the frozen
 *    `sendingDomainSesIdentities` table — a Mandrill-only deployment must not be
 *    shown an SES provisioning run;
 *  - the ROWS decide on their own when they carry real identity state, so a
 *    switched-off hatch keeps its published records on screen.
 *
 * The component queries for itself by design, so the reads are stubbed the way
 * the shipped `MandrillDomainStatus` suite stubs its own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';

const stubs = {
	Icon: { template: '<i />' },
	UiButton: { template: '<button><slot /></button>' },
};

interface Route {
	deliverabilityFallback?: { isEnabled: boolean; relayProviderType: string };
}

interface DomainRow {
	domainId: string;
	domain: string;
	status: string;
	dnsRecords?: { spf?: { type: string; host: string; value: string } };
}

/** A domain with no identity row — what the query synthesises for every owner. */
const provisioning: DomainRow = {
	domainId: 'd1',
	domain: 'example.com',
	status: 'provisioning',
};

async function mountPanel(routes: Route[], relayDomains: DomainRow[]) {
	vi.stubGlobal('computed', computed);
	// REAL refs, not `{ value }` literals: the template renders `relayDomains`
	// directly, and Vue only unwraps something `isRef` says is a ref — a plain
	// object silently iterates as itself and every row comes out blank.
	vi.stubGlobal('useOrganizationQuery', () => ({ data: ref(routes) }));
	vi.stubGlobal('usePaginatedQuery', () => ({
		results: ref(relayDomains),
		status: ref('Exhausted'),
		loadMore: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	const component = (await import('../RelayDomainStatus.vue')).default;
	return mount(component, { global: { stubs } });
}

function isRendered(wrapper: { find: (selector: string) => { exists: () => boolean } }): boolean {
	return wrapper.find('[data-testid="relay-domain-status"]').exists();
}

// NOT `unstubAllGlobals`: the shared setup file installs Vue's reactivity
// primitives as globals, and clearing every stub would take those with it.
afterEach(() => {
	vi.resetModules();
});

describe('RelayDomainStatus', () => {
	it('shows the DNS plan for an SES hatch that is configured but not yet enabled', async () => {
		// The publish-then-enable order. An `isEnabled` filter in the flatMap would
		// hide this card from every operator who is mid-setup — the one who needs it.
		const wrapper = await mountPanel(
			[{ deliverabilityFallback: { isEnabled: false, relayProviderType: 'ses' } }],
			[provisioning]
		);
		expect(isRendered(wrapper)).toBe(true);
		expect(wrapper.text()).toContain(
			'Publish these records before automatic fallback can activate'
		);
	});

	it('shows it for an enabled SES hatch just the same', async () => {
		const wrapper = await mountPanel(
			[{ deliverabilityFallback: { isEnabled: true, relayProviderType: 'ses' } }],
			[provisioning]
		);
		expect(isRendered(wrapper)).toBe(true);
	});

	it('renders nothing when no escape hatch is configured at all', async () => {
		// The shipped bug: the query answers for every OWNED domain, so a Resend or
		// own-MTA-only deployment was told to wait for a provisioning run that would
		// never start.
		expect(isRendered(await mountPanel([{}], [provisioning]))).toBe(false);
		expect(isRendered(await mountPanel([], [provisioning]))).toBe(false);
	});

	it('renders nothing for a hatch of a kind these rows cannot describe', async () => {
		// Mandrill declares the same `domainVerification: 'api'` capability, but its
		// identities live in another table and are drawn by another card.
		const wrapper = await mountPanel(
			[{ deliverabilityFallback: { isEnabled: true, relayProviderType: 'mandrill' } }],
			[provisioning]
		);
		expect(isRendered(wrapper)).toBe(false);
	});

	it('keeps published records on screen after the hatch is removed', async () => {
		const wrapper = await mountPanel(
			[{}],
			[
				{
					...provisioning,
					status: 'pending',
					dnsRecords: { spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com' } },
				},
			]
		);
		expect(isRendered(wrapper)).toBe(true);
		expect(wrapper.text()).toContain('v=spf1 include:amazonses.com');
	});
});
