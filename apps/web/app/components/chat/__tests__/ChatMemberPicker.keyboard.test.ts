/**
 * Adding members to a new channel or DM from the keyboard. The dialogs own the
 * search and who may be added; the picker (on the shared combobox) offers
 * those people while a query is typed, Enter adds the highlighted one, clears
 * the query and keeps the list ready for the next, and each member is added
 * once.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref } from 'vue';
import ChatMemberPicker, { type SelectedChatMember } from '../ChatMemberPicker.vue';
import UiAvatar from '~/components/ui/Avatar.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

enableAutoUnmount(afterEach);

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const PEOPLE = [
	{ memberId: 'm_ada', name: 'Ada Marlow', email: 'ada@example.com' },
	{ memberId: 'm_adrian', name: 'Adrian Kohl', email: 'adrian@example.com' },
	{ memberId: 'm_ben', name: null, email: 'ben@example.com' },
];

/** A dialog's side: its own search, leaving out who is already picked (unless not). */
function mountPicker({ excludePicked = true } = {}) {
	const selected = ref<SelectedChatMember[]>([]);
	const query = ref('');
	const Dialog = defineComponent({
		setup() {
			const candidates = computed(() =>
				PEOPLE.filter(
					(p) =>
						!(excludePicked && selected.value.some((s) => s.memberId === p.memberId)) &&
						(p.name ?? p.email).toLowerCase().includes(query.value.toLowerCase())
				)
			);
			return () =>
				h(ChatMemberPicker, {
					modelValue: selected.value,
					'onUpdate:modelValue': (next: SelectedChatMember[]) => (selected.value = next),
					query: query.value,
					'onUpdate:query': (next: string) => (query.value = next),
					candidates: candidates.value,
				});
		},
	});
	const wrapper = mount(Dialog, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { UiAvatar },
			stubs: { Icon: true },
		},
	});
	return { wrapper, selected, query };
}

const options = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));

async function type(input: HTMLInputElement, text: string) {
	input.value = text;
	input.dispatchEvent(new Event('input'));
	await flushPromises();
}

async function press(input: HTMLElement, key: string) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	input.dispatchEvent(event);
	await flushPromises();
	return event;
}

describe('ChatMemberPicker from the keyboard', () => {
	it('is a labelled combobox that offers nothing until something is typed', async () => {
		const { wrapper } = mountPicker();
		const input = wrapper.get('input');
		expect(input.attributes('role')).toBe('combobox');
		expect(wrapper.get(`label[for="${input.attributes('id')}"]`).text()).toBe('Members');
		await type(input.element, '');
		expect(options()).toHaveLength(0);
		expect(input.attributes('aria-expanded')).toBe('false');
	});

	it('adds the highlighted member with Enter, clears the query, and keeps the chips', async () => {
		const { wrapper, selected, query } = mountPicker();
		const input = wrapper.get<HTMLInputElement>('input').element;
		await type(input, 'ad');
		expect(options().map((o) => o.textContent?.trim())).toEqual(['Ada Marlow', 'Adrian Kohl']);
		expect(document.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe(
			'Matching members'
		);

		await press(input, 'ArrowDown');
		const enter = await press(input, 'Enter');
		expect(enter.defaultPrevented).toBe(true);
		expect(selected.value).toEqual([{ memberId: 'm_adrian', label: 'Adrian Kohl' }]);
		expect(query.value).toBe('');

		// The next one: the top match is highlighted, Enter adds it.
		await type(input, 'a');
		expect(options().map((o) => o.textContent?.trim())).toEqual(['Ada Marlow', 'ben@example.com']);
		await press(input, 'Enter');
		expect(selected.value.map((m) => m.memberId)).toEqual(['m_adrian', 'm_ada']);
		expect(wrapper.findAll('button[aria-label^="Remove"]')).toHaveLength(2);
		expect(document.activeElement === input || document.activeElement === document.body).toBe(true);
	});

	it('adds a member once, even if the dialog still offers them', async () => {
		const { wrapper, selected } = mountPicker({ excludePicked: false });
		const input = wrapper.get<HTMLInputElement>('input').element;
		for (let i = 0; i < 2; i++) {
			await type(input, 'ada');
			options()[0]!.click();
			await flushPromises();
		}
		expect(selected.value).toEqual([{ memberId: 'm_ada', label: 'Ada Marlow' }]);
	});

	it('closes the list with Escape and keeps what was typed', async () => {
		const { wrapper, query } = mountPicker();
		const input = wrapper.get<HTMLInputElement>('input').element;
		await type(input, 'ad');
		await press(input, 'Escape');
		expect(options()).toHaveLength(0);
		expect(query.value).toBe('ad');
	});
});
