// @vitest-environment happy-dom
/**
 * The reader's single consolidated AI strip:
 *   - renders NOTHING when the thread doesn't warrant a summary and nothing is
 *     cached (zero height, fail-soft)
 *   - a warm summary cache paints the collapsed one-line gist; "more" expands it
 *   - Ask and Draft reply are mutually exclusive — opening one closes the other
 *   - a suggestion card emits `use-reply` with the exact suggestion text (the
 *     reader opens the same prefilled composer it did before consolidation)
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxAiStrip from '../PostboxAiStrip.vue';

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
	vi.stubGlobal('useConvexQuery', () => ({ data: cacheData, isLoading: cacheLoading }));
	vi.stubGlobal('useBackendOperation', (_action: unknown, opts: { label?: string }) => {
		switch (opts?.label) {
			case 'Ask about this thread':
				return { run: askRun, isLoading: askLoading };
			case 'Suggest replies':
				return { run: suggestRun, isLoading: suggestLoading };
			default:
				return { run: genRun, isLoading: genLoading };
		}
	});
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
	genRun.mockResolvedValue(null);
	askRun.mockResolvedValue(undefined);
	suggestRun.mockResolvedValue(undefined);
});

const iconStub = { props: ['name'], template: '<span />' };
const mdStub = { props: ['source'], template: '<div class="md">{{ source }}</div>' };

function mountStrip(props: { messageId?: string; warrantsSummary?: boolean } = {}) {
	return mount(PostboxAiStrip, {
		props: { messageId: 'msg-1', warrantsSummary: false, ...props },
		global: { stubs: { Icon: iconStub, AssistantMarkdown: mdStub } },
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

	it('is visible with only the actions when the thread warrants a summary but none exists', async () => {
		genRun.mockResolvedValue(null); // generation fails → no gist, strip still there
		const wrapper = mountStrip({ warrantsSummary: true });
		await flushPromises();
		expect(wrapper.find('[data-testid="postbox-ai-strip"]').exists()).toBe(true);
		expect(wrapper.get('[aria-label="Ask about this thread"]').exists()).toBe(true);
		expect(wrapper.get('[aria-label="Draft a reply"]').exists()).toBe(true);
	});

	it('keeps Ask and Draft reply mutually exclusive', async () => {
		suggestRun.mockResolvedValue({ replies: ['Sounds good.'] });
		const wrapper = mountStrip({ warrantsSummary: true });
		await flushPromises();

		// Open Ask → the ask input appears.
		await wrapper.get('[aria-label="Ask about this thread"]').trigger('click');
		expect(wrapper.find('[data-testid="postbox-ask-thread"]').exists()).toBe(true);

		// Open Draft reply → Ask closes, suggestions appear.
		await wrapper.get('[aria-label="Draft a reply"]').trigger('click');
		await flushPromises();
		expect(wrapper.find('[data-testid="postbox-ask-thread"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Sounds good.');
	});

	it('emits use-reply with the exact suggestion text', async () => {
		suggestRun.mockResolvedValue({ replies: ['On it — will send today.'] });
		const wrapper = mountStrip({ warrantsSummary: true });
		await flushPromises();

		await wrapper.get('[aria-label="Draft a reply"]').trigger('click');
		await flushPromises();

		await wrapper.get('[aria-label="Suggested replies"] button').trigger('click');
		expect(wrapper.emitted('use-reply')).toBeTruthy();
		expect(wrapper.emitted('use-reply')![0]).toEqual(['On it — will send today.']);
	});

	it('answers an Ask question inline and keeps the ephemeral history', async () => {
		askRun.mockResolvedValue({ answer: 'We ship on the 14th.' });
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
