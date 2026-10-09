// @vitest-environment happy-dom
/**
 * "Ask about this thread" (PostboxAiStrip), opened from the reader's Overview
 * and Answer mode's menu:
 *   - it opens straight on Ask, focused, and closes on request
 *   - it answers inline and keeps the ephemeral history
 *   - it reads and generates no summary (the thread brief replaced that,
 *     ADR-0072) and never dispatches suggested replies
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

const queried = vi.fn();
// Per-action mocks, dispatched by the operation's `label`.
const askRun = vi.fn(async (_a: unknown): Promise<unknown> => undefined);
const otherRun = vi.fn(async (_a: unknown): Promise<unknown> => undefined);
const askLoading = ref(false);

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', (...args: unknown[]) => {
		queried(...args);
		return { data: ref(null), isLoading: ref(false) };
	});
	vi.stubGlobal(
		'useBackendOperation',
		(_action: unknown, opts: { label?: string | (() => string) }) => {
			const label = typeof opts?.label === 'function' ? opts.label() : opts?.label;
			return label === 'Ask about this thread'
				? { run: askRun, isLoading: askLoading }
				: { run: otherRun, isLoading: ref(false) };
		}
	);
});

beforeEach(() => {
	askLoading.value = false;
	askRun.mockReset();
	otherRun.mockReset();
	queried.mockReset();
	askRun.mockResolvedValue({ ok: false });
});

const iconStub = { props: ['name'], template: '<span />' };
const mdStub = { props: ['source'], template: '<div class="md">{{ source }}</div>' };

function mountStrip() {
	return mount(PostboxAiStrip, {
		attachTo: document.body,
		props: { messageId: 'msg-1' },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: iconStub, AssistantMarkdown: mdStub },
		},
	});
}

describe('PostboxAiStrip (Ask about this thread)', () => {
	it('opens straight on Ask, focused, and closes on request', async () => {
		const wrapper = mountStrip();
		await flushPromises();
		expect(wrapper.find('[data-testid="postbox-ask-thread"]').exists()).toBe(true);
		expect(document.activeElement).toBe(wrapper.find('input').element);
		await wrapper.get('[data-testid="postbox-ask-close"]').trigger('click');
		expect(wrapper.emitted('close')).toHaveLength(1);
		wrapper.unmount();
	});

	it('reads no summary and dispatches nothing but Ask', async () => {
		const wrapper = mountStrip();
		await flushPromises();
		expect(queried).not.toHaveBeenCalled();
		expect(otherRun).not.toHaveBeenCalled();
		expect(wrapper.find('[aria-label="Draft a reply"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('answers an Ask question inline and keeps the ephemeral history', async () => {
		askRun.mockResolvedValue({ ok: true, result: { answer: 'We ship on the 14th.' } });
		const wrapper = mountStrip();
		await flushPromises();

		await wrapper.find('input').setValue('When do we ship?');
		await wrapper.find('input').trigger('keydown.enter');
		await flushPromises();

		expect(askRun).toHaveBeenCalledTimes(1);
		expect(wrapper.text()).toContain('When do we ship?');
		expect(wrapper.find('.md').text()).toContain('We ship on the 14th.');
		wrapper.unmount();
	});
});
