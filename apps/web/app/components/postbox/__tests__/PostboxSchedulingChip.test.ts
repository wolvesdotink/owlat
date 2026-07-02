// @vitest-environment happy-dom
/**
 * PostboxSchedulingChip behavior:
 *   - clicking the chip calls suggestReplies with focus 'scheduling' and the
 *     verbatim proposedTimes, then renders the returned options as reply buttons
 *   - picking a reply emits use-reply with that text
 *   - the dismiss button emits dismiss (the parent hides it for the session)
 *   - a failed action (undefined) leaves no reply buttons (fail-soft)
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxSchedulingChip from '../PostboxSchedulingChip.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const suggestRun = vi.fn(async (_args: unknown): Promise<unknown> => undefined);
const suggestLoading = ref(false);

beforeAll(() => {
	vi.stubGlobal('useBackendOperation', () => ({
		run: suggestRun,
		isLoading: suggestLoading,
	}));
});

beforeEach(() => {
	suggestLoading.value = false;
	suggestRun.mockReset();
	suggestRun.mockResolvedValue(undefined);
});

const iconStub = { props: ['name'], template: '<span />' };

function mountChip(
	props: { messageId: string; proposedTimes: string[] } = {
		messageId: 'msg-1',
		proposedTimes: ['Tuesday afternoon'],
	},
) {
	return mount(PostboxSchedulingChip, {
		props,
		global: { stubs: { Icon: iconStub } },
	});
}

describe('PostboxSchedulingChip', () => {
	it('renders the scheduling prompt chip', () => {
		const wrapper = mountChip();
		expect(wrapper.text()).toContain('Scheduling request');
	});

	it('drafts scheduling-focused replies on click and shows the options', async () => {
		suggestRun.mockResolvedValue({ replies: ['Tuesday works for me.', 'How about Thursday?'] });
		const wrapper = mountChip();

		await wrapper.findAll('button')[0]!.trigger('click');
		await flushPromises();

		expect(suggestRun).toHaveBeenCalledTimes(1);
		expect(suggestRun.mock.calls[0]![0]).toMatchObject({
			messageId: 'msg-1',
			focus: 'scheduling',
			proposedTimes: ['Tuesday afternoon'],
		});
		expect(wrapper.text()).toContain('Tuesday works for me.');
		expect(wrapper.text()).toContain('How about Thursday?');
	});

	it('emits use-reply when a suggested reply is picked', async () => {
		suggestRun.mockResolvedValue({ replies: ['Tuesday works for me.'] });
		const wrapper = mountChip();

		await wrapper.findAll('button')[0]!.trigger('click');
		await flushPromises();

		const replyBtn = wrapper.find('[aria-label="Suggested scheduling replies"] button');
		await replyBtn.trigger('click');

		expect(wrapper.emitted('use-reply')?.[0]).toEqual(['Tuesday works for me.']);
	});

	it('emits dismiss from the dismiss button', async () => {
		const wrapper = mountChip();
		await wrapper.find('[aria-label="Dismiss scheduling suggestion"]').trigger('click');
		expect(wrapper.emitted('dismiss')).toHaveLength(1);
	});

	it('shows no reply options when the action fails (fail-soft)', async () => {
		suggestRun.mockResolvedValue(undefined);
		const wrapper = mountChip();

		await wrapper.findAll('button')[0]!.trigger('click');
		await flushPromises();

		expect(wrapper.find('[aria-label="Suggested scheduling replies"]').exists()).toBe(false);
	});
});
