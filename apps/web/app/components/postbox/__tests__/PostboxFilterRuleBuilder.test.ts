/**
 * The filter editor offers, per mailbox, only actions that can take effect.
 * A connected mailbox's filters run only through "Run on existing mail", which
 * never forwards, deletes or discards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxFilterRuleBuilder from '../PostboxFilterRuleBuilder.vue';
import type { FilterAction } from '~/composables/postbox/usePostboxFilters';

const HOSTED = { scope: 'personal' };
const CONNECTED = { scope: 'personal', kind: 'external' };

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		useConvexQuery: () => ({
			data: computed(() => undefined),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}),
		usePostboxFolders: () => ({ folders: ref([]) }),
		usePostboxLabels: () => ({ labels: ref([]) }),
	});
});

function mountBuilder(mailbox: Record<string, unknown>, actions: FilterAction[]) {
	return mount(PostboxFilterRuleBuilder, {
		props: {
			mailboxId: 'mb_1' as never,
			mailbox,
			modelValue: {
				name: 'Receipts',
				conditions: [{ field: 'from', op: 'contains', value: 'shop' }],
				actions,
				matchType: 'all',
				stopProcessing: false,
			},
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { UiCheckbox: true, UiQueryBoundary: true },
		},
	});
}

const actionChoices = (wrapper: ReturnType<typeof mountBuilder>, row: number) =>
	wrapper
		.findAll(`select[aria-label="Action ${row + 1}"] option`)
		.map((o) => (o.element as HTMLOptionElement).value);

describe('the filter editor, per mailbox kind', () => {
	it('offers forward, delete and discard on a hosted mailbox and says nothing', () => {
		const wrapper = mountBuilder(HOSTED, [{ type: 'addLabel' }]);
		expect(actionChoices(wrapper, 0)).toEqual(
			expect.arrayContaining(['forward', 'delete', 'discard'])
		);
		expect(wrapper.find('[data-testid="connected-mailbox-notice"]').exists()).toBe(false);
		expect(wrapper.findComponent({ name: 'UiCheckbox' }).exists()).toBe(true);
	});

	it('leaves forward, delete and discard out on a connected mailbox and says why', () => {
		const wrapper = mountBuilder(CONNECTED, [{ type: 'addLabel' }]);
		const choices = actionChoices(wrapper, 0);
		expect(choices).not.toContain('forward');
		expect(choices).not.toContain('delete');
		expect(choices).not.toContain('discard');
		expect(choices).toContain('moveToFolder');
		expect(wrapper.get('[data-testid="connected-mailbox-notice"]').text()).toContain(
			'does not run on new mail'
		);
		// A run applies one filter at a time, so there is nothing later to stop.
		expect(wrapper.findComponent({ name: 'UiCheckbox' }).exists()).toBe(false);
	});

	it('keeps a saved forward editable on a connected mailbox and says it does nothing', () => {
		const wrapper = mountBuilder(CONNECTED, [
			{ type: 'forward', forwardTo: 'desk@elsewhere.test' },
			{ type: 'addLabel' },
		]);
		expect(actionChoices(wrapper, 0)).toContain('forward');
		// The other row is not offered the action it cannot run.
		expect(actionChoices(wrapper, 1)).not.toContain('forward');
		const notes = wrapper.findAll('[data-testid="filter-action-unavailable"]');
		expect(notes).toHaveLength(1);
		expect(notes[0]!.text()).toContain('never runs');
	});
});
