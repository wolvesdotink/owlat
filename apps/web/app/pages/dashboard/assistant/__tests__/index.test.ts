// @vitest-environment happy-dom
/**
 * The Assistant page's conversation list, question field and feed wiring.
 *
 * #1051: each conversation is a real selection button (current one marked with
 * `aria-current`), Rename and Delete sit behind a More actions button beside
 * it rather than inside it, the question field has a name that outlives its
 * placeholder, and closing the phone drawer puts focus in the question field.
 *
 * #1050: the page feeds streamed content to useFollowLatest, so a reader who
 * scrolled up sees the Jump to latest pill instead of being pulled down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, inject, nextTick, provide, ref } from 'vue';
import UiDropdownMenu from '@owlat/ui/components/ui/DropdownMenu.vue';
import UiDropdownMenuItem from '@owlat/ui/components/ui/DropdownMenuItem.vue';
import AssistantComposer from '~/components/assistant/AssistantComposer.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AssistantPage from '../index.vue';

type Message = {
	_id: string;
	role: 'user' | 'assistant';
	text: string;
	status: string;
	toolCalls: { status: string }[];
};

const conversations = ref([
	{
		_id: 'conv_1',
		title: 'Campaign recap for the October launch',
		lastMessageAt: 1_700_000_000_000,
	},
	{ _id: 'conv_2', title: 'Re-engagement ideas', lastMessageAt: 1_699_000_000_000 },
]);
const activeId = ref<string | null>('conv_1');
const messages = ref<Message[]>([]);
const selectConversation = vi.fn((id: string) => {
	activeId.value = id;
});

// The drawer is a plain wrapper with the same v-model:open contract; its
// off-canvas mechanics have their own suite.
const RailDrawerStub = defineComponent({
	props: { open: Boolean, navigationTitle: String },
	emits: ['update:open'],
	setup:
		(_props, { slots }) =>
		() =>
			h('div', { 'data-testid': 'rail' }, slots.default?.()),
});

beforeEach(() => {
	activeId.value = 'conv_1';
	messages.value = [];
	selectConversation.mockClear();
	Object.assign(globalThis, {
		// The dropdown's auto-imports.
		provide,
		inject,
		useI18n: i18nStubs.useI18n,
		useHead: vi.fn(),
		definePageMeta: vi.fn(),
		useAssistant: () => ({
			activeId,
			conversations,
			conversationsLoading: ref(false),
			conversationsError: ref(null),
			refetchConversations: vi.fn(),
			messages,
			messagesError: ref(null),
			refetchMessages: vi.fn(),
			activeConversation: ref(conversations.value[0]),
			streaming: ref(false),
			selectConversation,
			newConversation: vi.fn(),
			send: vi.fn(async () => ({ ok: true })),
			stop: vi.fn(),
			rename: vi.fn(),
			remove: vi.fn(),
		}),
	});
});

function mountPage(options: { attachTo?: HTMLElement } = {}): VueWrapper {
	return mount(AssistantPage, {
		attachTo: options.attachTo,
		global: {
			plugins: [createTestI18n()],
			components: { UiDropdownMenu, UiDropdownMenuItem, AssistantComposer },
			stubs: {
				UiRailDrawer: RailDrawerStub,
				UiConfirmationDialog: true,
				AssistantMessage: true,
			},
		},
	}) as VueWrapper;
}

const rowButtons = (w: VueWrapper) => w.findAll('[data-testid="assistant-conversation"]');

describe('Assistant conversation list (#1051)', () => {
	it('makes every conversation a selection button, the open one marked current', async () => {
		const w = mountPage();
		const rows = rowButtons(w);
		expect(rows.map((b) => b.attributes('title'))).toEqual([
			'Campaign recap for the October launch',
			'Re-engagement ideas',
		]);
		expect(rows.map((b) => b.attributes('aria-current'))).toEqual(['page', undefined]);
		expect(rows[0]!.text()).toContain('Campaign recap for the October launch');

		await rows[1]!.trigger('click');
		expect(selectConversation).toHaveBeenCalledWith('conv_2');
		w.unmount();
	});

	it('keeps Rename and Delete out of the selection button, behind a named More actions button', async () => {
		const w = mountPage();
		for (const row of rowButtons(w)) {
			expect(row.findAll('button, input, a, [role="button"]')).toHaveLength(0);
		}
		const more = w.findAll('[data-testid="assistant-conversation-actions"]');
		expect(more).toHaveLength(2);
		expect(more[0]!.attributes('aria-label')).toBe(
			'More actions for Campaign recap for the October launch'
		);
		expect(more[0]!.classes()).toEqual(expect.arrayContaining(['w-8', 'h-8']));

		await more[0]!.trigger('click');
		await flushPromises();
		const items = Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((el) =>
			el.textContent?.trim()
		);
		expect(items).toEqual(['Rename conversation', 'Delete conversation']);
		w.unmount();
	});

	it('shows the More actions button without hover on touch screens', () => {
		const w = mountPage();
		const menu = w
			.find('[data-testid="assistant-conversation-actions"]')
			.element.closest('.relative.inline-block');
		expect(menu?.className).toContain('[@media(hover:none)]:opacity-100');
		w.unmount();
	});
});

describe('Assistant question field (#1051)', () => {
	it('has a label that outlives the placeholder and is described by the hint', () => {
		const w = mountPage();
		const textarea = w.get('textarea');
		const label = w.get(`label[for="${textarea.attributes('id')}"]`);
		expect(label.text()).toBe('Question for the assistant');
		expect(label.classes()).toContain('sr-only');
		const hint = w.get(`#${CSS.escape(textarea.attributes('aria-describedby')!)}`);
		expect(hint.text()).toContain('Shift+Enter');
		w.unmount();
	});

	it('moves focus to the question field when the phone drawer closes', async () => {
		const w = mountPage({ attachTo: document.body });
		const drawer = w.findComponent(RailDrawerStub);
		drawer.vm.$emit('update:open', true);
		await nextTick();
		drawer.vm.$emit('update:open', false);
		await flushPromises();

		expect(document.activeElement).toBe(w.get('textarea').element);
		w.unmount();
	});
});

describe('Assistant feed follows only a reader at the end (#1050)', () => {
	function geometry(el: HTMLElement) {
		const box = { scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 };
		Object.defineProperty(el, 'scrollHeight', { get: () => box.scrollHeight });
		Object.defineProperty(el, 'clientHeight', { get: () => box.clientHeight });
		Object.defineProperty(el, 'scrollTop', {
			get: () => box.scrollTop,
			set: (v: number) => (box.scrollTop = v),
		});
		(el as unknown as { scrollTo: (o: ScrollToOptions) => void }).scrollTo = (o) => {
			box.scrollTop = Math.min(o.top ?? 0, box.scrollHeight - box.clientHeight);
		};
		return box;
	}

	it('raises Jump to latest instead of scrolling a reader who scrolled up', async () => {
		messages.value = [
			{ _id: 'm1', role: 'user', text: 'Hi', status: 'done', toolCalls: [] },
			{ _id: 'm2', role: 'assistant', text: 'Hel', status: 'streaming', toolCalls: [] },
		];
		const w = mountPage();
		await flushPromises();
		const feed = w.get('.overflow-y-auto.px-4').element as HTMLElement;
		const box = geometry(feed);
		await w.get('.overflow-y-auto.px-4').trigger('scroll');
		box.scrollTop = 300;
		await w.get('.overflow-y-auto.px-4').trigger('scroll');

		box.scrollHeight = 2400;
		messages.value = [
			messages.value[0]!,
			{ ...messages.value[1]!, text: 'Hello, here is a long answer' },
		];
		await flushPromises();

		expect(box.scrollTop).toBe(300);
		const pill = w.get('[data-testid="assistant-jump-latest"]');
		expect(pill.text()).toContain('Jump to latest');

		await pill.trigger('click');
		await flushPromises();
		expect(box.scrollTop).toBe(1900);
		expect(w.find('[data-testid="assistant-jump-latest"]').exists()).toBe(false);
		w.unmount();
	});
});
