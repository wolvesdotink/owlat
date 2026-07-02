// @vitest-environment happy-dom
/**
 * Auto-summary strip behavior:
 *   - a warm cache paints the collapsed one-line summary WITHOUT calling the
 *     generate action; clicking it expands the bullets
 *   - a cold cache lazily generates and fills in
 *   - a null result (AI failure) hides the strip entirely (fail-soft)
 *
 * Plus the reader's eligibility predicate (long thread vs short thread), which
 * gates whether the strip is mounted at all.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxThreadSummary from '../PostboxThreadSummary.vue';
import { isLongThreadForSummary } from '../../../utils/postboxAutoSummary';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const cacheData = ref<unknown>(null);
const cacheLoading = ref(false);
const genRun = vi.fn(async (_args: unknown): Promise<unknown> => null);
const genLoading = ref(false);

beforeAll(() => {
	vi.stubGlobal('useConvexQuery', () => ({
		data: cacheData,
		isLoading: cacheLoading,
	}));
	vi.stubGlobal('useBackendOperation', () => ({
		run: genRun,
		isLoading: genLoading,
	}));
});

beforeEach(() => {
	cacheData.value = null;
	cacheLoading.value = false;
	genLoading.value = false;
	genRun.mockReset();
	genRun.mockImplementation(async () => null);
});

const iconStub = { props: ['name'], template: '<span />' };

function mountStrip() {
	return mount(PostboxThreadSummary, {
		props: { messageId: 'msg-1' },
		global: { stubs: { Icon: iconStub } },
	});
}

describe('PostboxThreadSummary', () => {
	it('renders a warm cache without calling the generate action', async () => {
		cacheData.value = { summary: '- Point one\n- Point two', messageCount: 5 };
		const wrapper = mountStrip();
		await flushPromises();

		const strip = wrapper.find('[data-testid="postbox-thread-summary"]');
		expect(strip.exists()).toBe(true);
		expect(wrapper.text()).toContain('Point one · Point two');
		expect(genRun).not.toHaveBeenCalled();
	});

	it('expands to the bullets on click', async () => {
		cacheData.value = { summary: '- Point one\n- Point two', messageCount: 5 };
		const wrapper = mountStrip();
		await flushPromises();

		await wrapper.find('button').trigger('click');
		const items = wrapper.findAll('li');
		expect(items).toHaveLength(2);
		expect(items[0]!.text()).toBe('Point one');
		expect(items[1]!.text()).toBe('Point two');
	});

	it('lazily generates when the cache is cold', async () => {
		genRun.mockResolvedValue({ summary: '- Generated', messageCount: 6 });
		const wrapper = mountStrip();
		await flushPromises();

		expect(genRun).toHaveBeenCalledTimes(1);
		expect(wrapper.text()).toContain('Generated');
	});

	it('hides the strip entirely when generation fails (null result)', async () => {
		genRun.mockResolvedValue(null);
		const wrapper = mountStrip();
		await flushPromises();

		expect(genRun).toHaveBeenCalledTimes(1);
		expect(wrapper.find('[data-testid="postbox-thread-summary"]').exists()).toBe(false);
	});
});

describe('isLongThreadForSummary', () => {
	it('is true for a thread of >= 5 messages', () => {
		const msgs = Array.from({ length: 5 }, () => ({ snippet: 'hi' }));
		expect(isLongThreadForSummary(msgs)).toBe(true);
	});

	it('is false for a short thread with little body text', () => {
		const msgs = [{ textBodyInline: 'thanks' }, { textBodyInline: 'you too' }];
		expect(isLongThreadForSummary(msgs)).toBe(false);
	});

	it('is true for a short thread with a very long body', () => {
		const msgs = [{ textBodyInline: 'x'.repeat(9000) }];
		expect(isLongThreadForSummary(msgs)).toBe(true);
	});
});
