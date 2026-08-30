// @vitest-environment happy-dom
/**
 * The search bar's primary contract: Enter runs WHAT THE USER TYPED.
 *
 * The autocomplete dropdown sits directly under the caret, so it is one step
 * away from stealing that key. With a pre-selected first row and a history list
 * matched by substring, Enter would submit `meeting notes` for someone who
 * typed `notes`, insert `in:` for someone who typed `in`, and — because every
 * terminal completion appends a trailing space, emptying the active token —
 * replace a half-built query with an unrelated old one.
 *
 * These cases pin the sentinel down: nothing is selected until an arrow key
 * selects it, and history is only offered for an empty box.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxSearchBar from '../PostboxSearchBar.vue';
import { LEGACY_MAIL_RECENTS_KEY } from '~/lib/commandPaletteRecents';
import { useCommandPaletteRecents } from '~/composables/useCommandPaletteRecents';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	// No address book and no labels: the grammar and the history are what these
	// cases are about.
	vi.stubGlobal('useConvexQuery', () => ({ data: ref([]) }));
	vi.stubGlobal('useDebouncedSearch', () => ({ query: ref(''), debouncedQuery: ref('') }));
	vi.stubGlobal('usePostboxLabels', () => ({ labels: ref([]) }));
	// The real history store: the bar reads the one scope-tagged palette store
	// under the Mail tag, so seeding the retired key below also exercises the
	// migration that folds it in.
	vi.stubGlobal('useCommandPaletteRecents', useCommandPaletteRecents);
});

const iconStub = { props: ['name'], template: '<span />' };

function mountBar(history: string[]) {
	localStorage.clear();
	localStorage.setItem(LEGACY_MAIL_RECENTS_KEY, JSON.stringify(history));
	return mount(PostboxSearchBar, {
		props: { modelValue: '' },
		global: { plugins: [createTestI18n()], stubs: { Icon: iconStub } },
	});
}

/** Type into the real input the way the component listens for it. */
async function type(wrapper: ReturnType<typeof mountBar>, value: string) {
	const input = wrapper.get('input');
	await input.setValue(value);
	await input.trigger('input');
	return input;
}

describe('PostboxSearchBar — Enter submits the typed query', () => {
	it('searches the typed word rather than a history entry that contains it', async () => {
		const wrapper = mountBar(['meeting notes']);
		const input = await type(wrapper, 'notes');

		await input.trigger('keydown', { key: 'Enter' });

		expect(wrapper.emitted('submit')?.[0]?.[0]).toBe('notes');
	});

	it('searches a bare word that is also an operator prefix', async () => {
		// `in` and `is` both open the grammar list; Enter must still search for
		// the word instead of completing it to `in:`.
		const wrapper = mountBar([]);
		const input = await type(wrapper, 'in');

		await input.trigger('keydown', { key: 'Enter' });

		expect(wrapper.emitted('submit')?.[0]?.[0]).toBe('in');
		expect((input.element as HTMLInputElement).value).toBe('in');
	});

	it('keeps a half-built query when the active token is the gap after a term', async () => {
		// The trailing space empties the token; history must not fill that gap
		// and must not be what Enter runs.
		const wrapper = mountBar(['is:starred older_than:1y']);
		const input = await type(wrapper, 'from:ines ');

		expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
		await input.trigger('keydown', { key: 'Enter' });

		expect(wrapper.emitted('submit')?.[0]?.[0]).toBe('from:ines ');
	});

	it('offers history for an empty box, and runs it once explicitly selected', async () => {
		const wrapper = mountBar(['meeting notes']);
		const input = wrapper.get('input');
		await input.trigger('focus');

		// Open, but with nothing selected — no row is marked, so Enter is still
		// the user's.
		expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
		expect(wrapper.find('[aria-selected="true"]').exists()).toBe(false);
		expect(input.attributes('aria-activedescendant')).toBeUndefined();

		await input.trigger('keydown', { key: 'ArrowDown' });
		expect(wrapper.find('[aria-selected="true"]').exists()).toBe(true);
		expect(input.attributes('aria-activedescendant')).toBeTruthy();

		await input.trigger('keydown', { key: 'Enter' });
		await wrapper.vm.$nextTick();
		expect(wrapper.emitted('submit')?.[0]?.[0]).toBe('meeting notes');
	});

	it('completes on Tab only after the user has selected a row', async () => {
		const wrapper = mountBar([]);
		const input = await type(wrapper, 'fr');

		await input.trigger('keydown', { key: 'Tab' });
		expect((input.element as HTMLInputElement).value).toBe('fr');

		await input.trigger('keydown', { key: 'ArrowDown' });
		await input.trigger('keydown', { key: 'Tab' });
		await wrapper.vm.$nextTick();
		expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe('from:');
	});

	it('drops a stale selection when the next keystroke re-ranks the rows', async () => {
		const wrapper = mountBar([]);
		const input = await type(wrapper, 'f');
		await input.trigger('keydown', { key: 'ArrowDown' });
		expect(wrapper.find('[aria-selected="true"]').exists()).toBe(true);

		await type(wrapper, 'fi');
		expect(wrapper.find('[aria-selected="true"]').exists()).toBe(false);

		await input.trigger('keydown', { key: 'Enter' });
		expect(wrapper.emitted('submit')?.[0]?.[0]).toBe('fi');
	});
});
