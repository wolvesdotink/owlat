// @vitest-environment happy-dom
/**
 * The chat rail is the room list: a failed read of it is not "No channels
 * yet" (#721). With nothing to list and a read error, the rail shows the error
 * and a Try again that asks the page to re-read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import ChatSidebar from '../ChatSidebar.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function render(error: Error | null) {
	return mount(ChatSidebar, {
		props: { channels: [], dms: [], isLoading: false, error },
		global: { plugins: [createTestI18n()], stubs: { UiSkeleton: true, UiAvatar: true } },
	});
}

describe('ChatSidebar read states', () => {
	it('says there are no channels when the lists are empty', () => {
		const wrapper = render(null);
		expect(wrapper.text()).toContain('No channels yet.');
		expect(wrapper.text()).not.toContain('Failed to load');
	});

	it('shows a failed read with Try again, not "No channels yet" (#721)', async () => {
		const wrapper = render(new Error('[CONVEX Q(chat/rooms:listMyChannels)] Server Error'));

		expect(wrapper.text()).not.toContain('No channels yet.');
		expect(wrapper.text()).toContain('Failed to load');
		const retry = wrapper.findAll('button').find((button) => button.text() === 'Try again');
		await retry!.trigger('click');
		expect(wrapper.emitted('retry')).toHaveLength(1);
	});
});
