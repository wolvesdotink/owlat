/**
 * Opened from the People view, the reader is headed by the topic name and
 * renames it in place, for a one-message topic and a long conversation alike.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, nextTick } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { POSTBOX_TOPIC_HEADING, type TopicHeading } from '~/utils/postboxPeople';
import PostboxThreadHeader from '../PostboxThreadHeader.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useClickOutside', () => {});
});

function mountHeader(messageCount: number, heading: TopicHeading) {
	return mount(PostboxThreadHeader, {
		props: { subject: 'Re: AW: Vertrag 2027', messageCount, messageId: 'm1' as never },
		global: {
			plugins: [createTestI18n()],
			provide: { [POSTBOX_TOPIC_HEADING as symbol]: computed(() => heading) },
			stubs: {
				PostboxOverflowMenu: true,
				PostboxReaderStickyBar: true,
				PostboxUnsubscribeChip: true,
			},
		},
		attachTo: document.body,
	});
}

const pencil = 'button[aria-label="Rename topic"]';

describe('reader header with a topic', () => {
	it.each([1, 7])('renames a %i-message topic in place', async (messageCount) => {
		const rename = vi.fn(async () => {});
		const wrapper = mountHeader(messageCount, {
			title: 'Contract renewal for 2027',
			subject: 'Re: AW: Vertrag 2027',
			source: 'ai',
			rename,
			reset: async () => {},
		});
		expect(wrapper.text()).toContain('Contract renewal for 2027');
		await wrapper.get(pencil).trigger('click');
		await nextTick();
		const input = wrapper.get('input');
		await input.setValue('Contract for 2027');
		await input.trigger('keydown', { key: 'Enter' });
		expect(rename).toHaveBeenCalledWith('Contract for 2027');
		wrapper.unmount();
	});

	it('offers the way back while renaming a name the user gave', async () => {
		const reset = vi.fn(async () => {});
		const wrapper = mountHeader(2, {
			title: 'Mine',
			subject: 'Theirs',
			source: 'user',
			rename: async () => {},
			reset,
		});
		await wrapper.get(pencil).trigger('click');
		await nextTick();
		await wrapper.get('button.underline').trigger('click');
		expect(reset).toHaveBeenCalled();
		wrapper.unmount();
	});

	it('offers "No reply needed" while the turn is the mailbox\'s', async () => {
		const noReply = vi.fn(async () => {});
		const wrapper = mountHeader(2, {
			title: 'Contract renewal',
			subject: 'Vertrag',
			source: 'subject',
			rename: async () => {},
			reset: async () => {},
			noReply,
		});
		await wrapper.get('button[aria-label="No reply needed"]').trigger('click');
		expect(noReply).toHaveBeenCalled();
		wrapper.unmount();
	});
});
