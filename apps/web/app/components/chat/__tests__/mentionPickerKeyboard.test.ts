/**
 * `@`-mentions from the keyboard, in every box that offers them: the chat
 * composer and both internal-note composers. The teammate list is the real
 * `ChatMentionPicker` on the shared suggestion popover, so ↑ ↓ move through
 * it, Enter inserts the highlighted teammate (and never sends or saves), and
 * the first Escape closes only the list.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, ref } from 'vue';
import ChatInput from '../ChatInput.vue';
import ChatMentionPicker from '../ChatMentionPicker.vue';
import NoteComposer from '~/components/inbox/NoteComposer.vue';
import TeamNoteComposer from '~/components/team/TeamNoteComposer.vue';
import UiAvatar from '~/components/ui/Avatar.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useComposerDrafts } from '~/composables/useComposerDrafts';

enableAutoUnmount(afterEach);

const PEOPLE = [
	{ memberId: 'm_ada', name: 'Ada Marlow', email: 'ada@example.com', image: null, handle: 'ada' },
	{
		memberId: 'm_adrian',
		name: 'Adrian Kohl',
		email: 'adrian@example.com',
		image: null,
		handle: 'adrian',
	},
];
const matching = (q: string) => PEOPLE.filter((p) => p.handle.startsWith(q.toLowerCase()));

const states = new Map<string, ReturnType<typeof ref>>();
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useChatMentionSearch: (query: () => string | null) => ({
			candidates: computed(() => {
				const q = query();
				return q === null ? [] : matching(q);
			}),
		}),
		useChatAttachments: () => ({ isUploading: ref(false), uploadFile: async () => null }),
		useState: (key: string, init: () => unknown) => {
			if (!states.has(key)) states.set(key, ref(init()));
			return states.get(key);
		},
	});
});
beforeEach(() => {
	states.clear();
	useComposerDrafts().bindUser(null);
});

const global = {
	plugins: [createTestI18n()],
	components: { ChatMentionPicker, UiAvatar },
	stubs: { Icon: true },
};

/** The teammate list's options (it renders at the end of the body). */
const options = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));

async function typeInto(box: HTMLTextAreaElement, text: string) {
	box.value = text;
	box.setSelectionRange(text.length, text.length);
	box.dispatchEvent(new Event('input'));
	await flushPromises();
}

async function press(box: HTMLElement, key: string) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	box.dispatchEvent(event);
	await flushPromises();
	return event;
}

type Host = {
	name: string;
	mount: () => { wrapper: VueWrapper; box: () => HTMLTextAreaElement; committed: () => number };
};

const HOSTS: Host[] = [
	{
		name: 'the chat composer',
		mount: () => {
			const send = vi.fn(async () => ({ ok: true }));
			const wrapper = mount(ChatInput, { props: { send }, attachTo: document.body, global });
			return {
				wrapper,
				box: () => wrapper.get<HTMLTextAreaElement>('textarea').element,
				committed: () => send.mock.calls.length,
			};
		},
	},
	{
		name: 'the internal note composer',
		mount: () => {
			const submit = vi.fn(async () => true);
			const wrapper = mount(NoteComposer, {
				props: { submit, candidatesFor: matching },
				attachTo: document.body,
				global,
			});
			return {
				wrapper,
				box: () => wrapper.get<HTMLTextAreaElement>('[data-testid="note-composer-input"]').element,
				committed: () => submit.mock.calls.length,
			};
		},
	},
	{
		name: 'the team thread composer',
		mount: () => {
			const submitNote = vi.fn(async () => true);
			const wrapper = mount(TeamNoteComposer, {
				props: {
					draftKey: 'team:th1',
					replyName: 'Ana Costa',
					candidatesFor: matching,
					submitNote,
				},
				attachTo: document.body,
				global,
			});
			return {
				wrapper,
				box: () =>
					wrapper.get<HTMLTextAreaElement>('[data-testid="team-composer-note-input"]').element,
				committed: () => submitNote.mock.calls.length,
			};
		},
	},
];

describe.each(HOSTS)('@-mentions from the keyboard in $name', ({ mount: mountHost }) => {
	it('arrows to the second teammate and Enter inserts it, without sending', async () => {
		const { box, committed } = mountHost();
		await typeInto(box(), 'ping @ad');
		expect(options().map((o) => o.textContent)).toEqual([
			expect.stringContaining('@ada'),
			expect.stringContaining('@adrian'),
		]);
		// The box names the highlighted teammate for assistive technology.
		expect(box().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);

		await press(box(), 'ArrowDown');
		expect(box().getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
		const enter = await press(box(), 'Enter');
		expect(enter.defaultPrevented).toBe(true);
		expect(box().value).toBe('ping @adrian ');
		expect(options()).toHaveLength(0);
		expect(committed()).toBe(0);
	});

	it('closes only the list on the first Escape and keeps the text', async () => {
		const { box, committed } = mountHost();
		await typeInto(box(), 'ping @a');
		expect(options()).toHaveLength(2);
		const escape = await press(box(), 'Escape');
		expect(escape.defaultPrevented).toBe(true);
		expect(options()).toHaveLength(0);
		expect(box().value).toBe('ping @a');
		expect(box().getAttribute('aria-activedescendant')).toBeNull();
		expect(committed()).toBe(0);
	});
});
