// @vitest-environment happy-dom
/**
 * THE DASHBOARD EDITOR NAMES CARDS FROM THE CATALOG, NOT FROM THE WIRE.
 *
 * `getAvailableCards` (`apps/api/convex/analytics/adaptiveDashboard.ts`) serves
 * every card's name and one-line description in English, because it is a read
 * model rather than a browser-only registry. The editor therefore resolves each
 * name through `useDashboardCardCopy()` — `sharedPkg.adaptiveDashboard.cards.*`
 * — and only falls back to the served English for a type the catalog has never
 * heard of (a bundled-plugin card). These tests pin both halves, and that no
 * `sharedPkg.` key path reaches the panel.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DashboardEditor from '../DashboardEditor.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const stubs = {
	// Teleport renders into `document.body`, i.e. outside the wrapper; a
	// pass-through keeps the panel inside the mounted tree so its text is
	// assertable.
	Teleport: { template: '<div><slot /></div>' },
	Icon: { template: '<i />' },
	UiButton: { template: '<button><slot /><slot name="iconLeft" /></button>' },
};

/** The wire shape, with wording deliberately unlike the catalog's. */
function availableCard(type: string) {
	return { type, label: `WIRE ${type}`, description: `WIRE DESC ${type}` };
}

/**
 * Mounted CLOSED and then opened, because that transition is what seeds the
 * editor's working copy of the active cards — a panel mounted already-open
 * shows an empty "Active Cards" list, exactly as it does in the app.
 */
async function mountEditor(
	overrides: Partial<InstanceType<typeof DashboardEditor>['$props']> = {}
) {
	const wrapper = mount(DashboardEditor, {
		props: {
			isOpen: false,
			cards: [{ type: 'verification_queue', size: 'large' as const }],
			availableCards: [
				availableCard('verification_queue'),
				availableCard('delivery_rates'),
				availableCard('cost_by_step'),
			],
			rules: [
				{
					condition: {},
					cards: [{ type: 'delivery_rates', size: 'small' as const }],
					priority: 10,
				},
			],
			...overrides,
		},
		global: { plugins: [createTestI18n()], stubs },
	});
	await wrapper.setProps({ isOpen: true });
	return wrapper;
}

describe('DashboardEditor — card names', () => {
	it('names an active card from the catalog, not from the query payload', async () => {
		const text = (await mountEditor()).text();
		expect(text).toContain('Review Queue');
		expect(text).toContain('Pending agent drafts needing review');
		expect(text).not.toContain('WIRE verification_queue');
		expect(text).not.toContain('WIRE DESC verification_queue');
	});

	it('names the add-a-card list from the catalog', async () => {
		const text = (await mountEditor()).text();
		// Not among the active cards, so these are the "Add Cards" entries.
		expect(text).toContain('LLM Cost by Step');
		expect(text).toContain('Token cost per agent-pipeline step');
		expect(text).not.toContain('WIRE cost_by_step');
	});

	it('names the cards inside an adaptive rule from the catalog', async () => {
		const text = (await mountEditor()).text();
		expect(text).toContain('Delivery Rates');
		expect(text).not.toContain('WIRE delivery_rates');
	});

	it('falls back to the served English for a card type the catalog does not know', async () => {
		const wrapper = await mountEditor({
			cards: [{ type: 'plugin_policy_pack', size: 'small' as const }],
			availableCards: [
				{
					type: 'plugin_policy_pack',
					label: 'Policy pack',
					description: 'Bundled plugin card.',
				},
			],
			rules: [],
		});
		const text = wrapper.text();
		expect(text).toContain('Policy pack');
		expect(text).toContain('Bundled plugin card.');
		expect(text).not.toContain('sharedPkg.');
	});

	it('renders no raw message key anywhere in the panel', async () => {
		const wrapper = await mountEditor();
		expect(wrapper.text()).not.toMatch(/sharedPkg\./);
		expectFullyLocalized(wrapper);
	});
});
