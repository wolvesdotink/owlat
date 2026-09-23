// @vitest-environment happy-dom
/**
 * The audience overview's Recent activity lines. The contact's name and the
 * verb used to be two sibling elements with no space between them, which read
 * "Marcus Oyelaranwas added" (#804). Each line is now one translated sentence
 * with the name as a parameter, so the spacing and the word order belong to the
 * catalog.
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import SubscriberActivityCard from '../SubscriberActivityCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import de from '~~/i18n/locales/de.json';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const ACTIVITY = [
	{
		_id: 'ac_1',
		activityType: 'created',
		occurredAt: Date.now(),
		contact: { _id: 'ct_1', firstName: 'Marcus', lastName: 'Oyelaran', email: 'm@example.com' },
	},
	{
		_id: 'ac_2',
		activityType: 'topic_confirmed',
		occurredAt: Date.now(),
		contact: { _id: 'ct_2', firstName: 'Hana', lastName: 'Sato', email: 'h@example.com' },
	},
	{ _id: 'ac_3', activityType: 'topic_unsubscribed', occurredAt: Date.now(), contact: null },
];

function mountCard(locale = 'en') {
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: ref(ACTIVITY),
		isLoading: ref(false),
		error: ref(null),
	}));
	vi.stubGlobal('formatCompactRelativeTime', () => '2m');
	const i18n = createTestI18n();
	// The shared helper ships `de` empty; load the real German catalog here.
	i18n.global.setLocaleMessage('de', de as never);
	i18n.global.locale.value = locale as never;
	return mount(SubscriberActivityCard, {
		global: {
			plugins: [i18n],
			stubs: {
				Icon: true,
				UiIconBox: true,
				UiQueryBoundary: { template: '<div><slot /></div>' },
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
			mocks: { formatCompactRelativeTime: () => '2m' },
		},
	});
}

const sentences = (wrapper: ReturnType<typeof mountCard>) =>
	wrapper.findAll('[data-testid="activity-sentence"]').map((line) => line.text());

describe('SubscriberActivityCard', () => {
	it('puts a space between the name and the verb', () => {
		const wrapper = mountCard();

		expect(sentences(wrapper)).toEqual([
			'Marcus Oyelaran was added',
			'Hana Sato confirmed their subscription',
			'Unknown unsubscribed from a topic',
		]);
		wrapper.unmount();
	});

	it('keeps the name a link to the contact', () => {
		const wrapper = mountCard();

		const link = wrapper.find('a[href="/dashboard/audience/contacts/ct_1"]');
		expect(link.text()).toBe('Marcus Oyelaran');
		wrapper.unmount();
	});

	it('lets German place the name in its own sentence', () => {
		const wrapper = mountCard('de');

		expect(sentences(wrapper)[0]).toBe('Marcus Oyelaran wurde hinzugefügt');
		wrapper.unmount();
	});
});
