/**
 * The reader's meta line leads with the subject an open topic was written
 * under, only when the topic's name says something else.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { POSTBOX_TOPIC_HEADING, type TopicHeading } from '~/utils/postboxPeople';
import PostboxTopicNameNote from '../PostboxTopicNameNote.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountNote(heading: Omit<TopicHeading, 'rename' | 'reset'>) {
	return mount(PostboxTopicNameNote, {
		global: {
			plugins: [createTestI18n()],
			provide: {
				[POSTBOX_TOPIC_HEADING as symbol]: computed(() => ({
					...heading,
					rename: async () => {},
					reset: async () => {},
				})),
			},
		},
	});
}

describe('topic name note', () => {
	it('shows the original subject only when it says something else', () => {
		const named = mountNote({
			title: 'Contract renewal for 2027',
			subject: 'Re: AW: Vertrag 2027',
			source: 'ai',
		});
		expect(named.text()).toContain('Re: AW: Vertrag 2027');
		const same = mountNote({ title: 'Vertrag 2027', subject: 'Re: Vertrag 2027', source: 'user' });
		expect(same.text()).not.toContain('Re: Vertrag 2027');
	});
});
