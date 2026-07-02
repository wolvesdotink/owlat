// @vitest-environment happy-dom
/**
 * "Ask about this thread…" footer input behavior:
 *   - submitting a question calls the askThread action and renders the answer
 *     inline below the question (kept as in-memory history)
 *   - a failed action (undefined result) shows the quiet fail-soft error line
 *     and does NOT append a history turn
 *   - Enter submits, Esc clears the input
 *   - changing the open thread (messageId) resets the ephemeral history
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxAskThread from '../PostboxAskThread.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const askRun = vi.fn(async (_args: unknown): Promise<unknown> => undefined);
const askLoading = ref(false);

beforeAll(() => {
	vi.stubGlobal('useBackendOperation', () => ({
		run: askRun,
		isLoading: askLoading,
	}));
});

beforeEach(() => {
	askLoading.value = false;
	askRun.mockReset();
	askRun.mockResolvedValue(undefined);
});

const iconStub = { props: ['name'], template: '<span />' };
const mdStub = { props: ['source'], template: '<div class="md">{{ source }}</div>' };

function mountAsk(props: { messageId: string } = { messageId: 'msg-1' }) {
	return mount(PostboxAskThread, {
		props,
		global: { stubs: { Icon: iconStub, AssistantMarkdown: mdStub } },
	});
}

describe('PostboxAskThread', () => {
	it('renders the answer inline below the question after a submit', async () => {
		askRun.mockResolvedValue({ answer: 'We ship on the 14th.' });
		const wrapper = mountAsk();

		await wrapper.find('input').setValue('When do we ship?');
		await wrapper.find('input').trigger('keydown.enter');
		await flushPromises();

		expect(askRun).toHaveBeenCalledTimes(1);
		expect(askRun.mock.calls[0]![0]).toMatchObject({
			messageId: 'msg-1',
			question: 'When do we ship?',
		});
		expect(wrapper.text()).toContain('When do we ship?');
		expect(wrapper.find('.md').text()).toContain('We ship on the 14th.');
		// input cleared after a successful answer
		expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
	});

	it('shows the fail-soft line and appends no history when the action fails', async () => {
		askRun.mockResolvedValue(undefined);
		const wrapper = mountAsk();

		await wrapper.find('input').setValue('anything');
		await wrapper.find('input').trigger('keydown.enter');
		await flushPromises();

		expect(wrapper.text()).toContain("Couldn't answer that right now");
		expect(wrapper.find('.md').exists()).toBe(false);
	});

	it('does not call the action for an empty question', async () => {
		const wrapper = mountAsk();
		await wrapper.find('input').setValue('   ');
		await wrapper.find('input').trigger('keydown.enter');
		await flushPromises();
		expect(askRun).not.toHaveBeenCalled();
	});

	it('replays prior history on a follow-up question', async () => {
		askRun.mockResolvedValueOnce({ answer: 'The 14th.' });
		const wrapper = mountAsk();

		await wrapper.find('input').setValue('deadline?');
		await wrapper.find('input').trigger('keydown.enter');
		await flushPromises();

		askRun.mockResolvedValueOnce({ answer: 'Alice.' });
		await wrapper.find('input').setValue('who signs off?');
		await wrapper.find('input').trigger('keydown.enter');
		await flushPromises();

		expect(askRun.mock.calls[1]![0]).toMatchObject({
			question: 'who signs off?',
			history: [{ question: 'deadline?', answer: 'The 14th.' }],
		});
	});

	it('clears the input on Esc', async () => {
		const wrapper = mountAsk();
		await wrapper.find('input').setValue('half typed');
		await wrapper.find('input').trigger('keydown.esc');
		await flushPromises();
		expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
		expect(askRun).not.toHaveBeenCalled();
	});

	it('resets the ephemeral history when the open thread changes', async () => {
		askRun.mockResolvedValue({ answer: 'answer one' });
		const wrapper = mountAsk();

		await wrapper.find('input').setValue('q1');
		await wrapper.find('input').trigger('keydown.enter');
		await flushPromises();
		expect(wrapper.find('.md').exists()).toBe(true);

		await wrapper.setProps({ messageId: 'msg-2' });
		await flushPromises();
		expect(wrapper.find('.md').exists()).toBe(false);
	});
});
