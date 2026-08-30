// @vitest-environment happy-dom
/**
 * The reader's single AI strip, now one line (plan §05):
 *   - renders NOTHING when the thread doesn't warrant a summary and nothing is
 *     cached (zero height, fail-soft)
 *   - a warm summary cache paints the collapsed one-line gist; "more" expands it
 *   - Ask is the only expandable section left, and it stays closed until asked
 *   - Draft reply is NOT here any more — it moved into PostboxInlineReply, and
 *     the strip must never dispatch mail.ai.suggestReplies again
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxAiStrip from '../PostboxAiStrip.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

// Summary cache read (useConvexQuery).
const cacheData = ref<unknown>(null);
const cacheLoading = ref(false);

// Per-action mocks, dispatched by the operation's `label`.
const genRun = vi.fn(async (_a: unknown): Promise<unknown> => null);
const askRun = vi.fn(async (_a: unknown): Promise<unknown> => undefined);
const suggestRun = vi.fn(async (_a: unknown): Promise<unknown> => undefined);
const genLoading = ref(false);
const askLoading = ref(false);
const suggestLoading = ref(false);

beforeAll(() => {
	// Every visible string flows through vue-i18n now: `useI18n` is a Nuxt
	// auto-import in the app, and the operation labels are getters resolved
	// against the real catalog.
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', () => ({ data: cacheData, isLoading: cacheLoading }));
	vi.stubGlobal(
		'useBackendOperation',
		(_action: unknown, opts: { label?: string | (() => string) }) => {
			const label = typeof opts?.label === 'function' ? opts.label() : opts?.label;
			switch (label) {
				case 'Ask about this thread':
					return { run: askRun, isLoading: askLoading };
				// The strip no longer owns Suggest replies; a dispatch under any
				// other label than the summary generator is a regression.
				case 'Suggest replies':
					return { run: suggestRun, isLoading: suggestLoading };
				default:
					return { run: genRun, isLoading: genLoading };
			}
		}
	);
});

beforeEach(() => {
	cacheData.value = null;
	cacheLoading.value = false;
	genLoading.value = false;
	askLoading.value = false;
	suggestLoading.value = false;
	genRun.mockReset();
	askRun.mockReset();
	suggestRun.mockReset();
	genRun.mockResolvedValue({ ok: true, result: null });
	askRun.mockResolvedValue({ ok: false });
	suggestRun.mockResolvedValue({ ok: false });
});

const iconStub = { props: ['name'], template: '<span />' };
const mdStub = { props: ['source'], template: '<div class="md">{{ source }}</div>' };

function mountStrip(props: { messageId?: string; warrantsSummary?: boolean } = {}) {
	return mount(PostboxAiStrip, {
		props: { messageId: 'msg-1', warrantsSummary: false, ...props },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: iconStub, AssistantMarkdown: mdStub },
		},
	});
}

describe('PostboxAiStrip', () => {
	it('renders nothing when the thread is too short and nothing is cached', async () => {
		const wrapper = mountStrip({ warrantsSummary: false });
		await flushPromises();
		expect(wrapper.find('[data-testid="postbox-ai-strip"]').exists()).toBe(false);
		// A short thread must not eagerly generate a summary.
		expect(genRun).not.toHaveBeenCalled();
	});

	it('paints a warm cached summary as a one-line gist, expandable via "more"', async () => {
		cacheData.value = { summary: '- Point one\n- Point two', messageCount: 5 };
		const wrapper = mountStrip({ warrantsSummary: true });
		await flushPromises();

		const strip = wrapper.find('[data-testid="postbox-ai-strip"]');
		expect(strip.exists()).toBe(true);
		expect(wrapper.text()).toContain('Point one · Point two');
		expect(genRun).not.toHaveBeenCalled();

		await wrapper.get('[aria-label="Toggle summary detail"]').trigger('click');
		const items = wrapper.findAll('li');
		expect(items).toHaveLength(2);
		expect(items[0]!.text()).toBe('Point one');
	});

	it('is visible with only the Ask link when the thread warrants a summary but none exists', async () => {
		genRun.mockResolvedValue({ ok: true, result: null }); // generation fails → no gist, strip still there
		const wrapper = mountStrip({ warrantsSummary: true });
		await flushPromises();
		expect(wrapper.find('[data-testid="postbox-ai-strip"]').exists()).toBe(true);
		expect(wrapper.get('[aria-label="Ask about this thread"]').exists()).toBe(true);
	});

	it('no longer offers Draft reply, and never dispatches suggestions', async () => {
		const wrapper = mountStrip({ warrantsSummary: true });
		await flushPromises();
		expect(wrapper.find('[aria-label="Draft a reply"]').exists()).toBe(false);

		// Opening the one section it does have must not reach the suggest action.
		await wrapper.get('[aria-label="Ask about this thread"]').trigger('click');
		await flushPromises();
		expect(suggestRun).not.toHaveBeenCalled();
	});

	it('keeps Ask closed until it is asked for, and toggles back shut', async () => {
		const wrapper = mountStrip({ warrantsSummary: true });
		await flushPromises();
		expect(wrapper.find('[data-testid="postbox-ask-thread"]').exists()).toBe(false);

		await wrapper.get('[aria-label="Ask about this thread"]').trigger('click');
		expect(wrapper.find('[data-testid="postbox-ask-thread"]').exists()).toBe(true);

		await wrapper.get('[aria-label="Ask about this thread"]').trigger('click');
		expect(wrapper.find('[data-testid="postbox-ask-thread"]').exists()).toBe(false);
	});

	it('answers an Ask question inline and keeps the ephemeral history', async () => {
		askRun.mockResolvedValue({ ok: true, result: { answer: 'We ship on the 14th.' } });
		const wrapper = mountStrip({ warrantsSummary: true });
		await flushPromises();

		await wrapper.get('[aria-label="Ask about this thread"]').trigger('click');
		await wrapper.find('input').setValue('When do we ship?');
		await wrapper.find('input').trigger('keydown.enter');
		await flushPromises();

		expect(askRun).toHaveBeenCalledTimes(1);
		expect(wrapper.text()).toContain('When do we ship?');
		expect(wrapper.find('.md').text()).toContain('We ship on the 14th.');
	});
});
