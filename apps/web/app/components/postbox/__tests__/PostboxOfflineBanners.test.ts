// @vitest-environment happy-dom
/**
 * PostboxOfflineBanners — the list pane's connectivity strip, extracted from
 * PostboxLayout.vue.
 *
 * What has to stay true after the extraction: the layout's outbox counts reach
 * the banner as props (a mis-wired prop would silently render the generic
 * offline line instead of "n queued", or hide the post-drain failure notice
 * entirely), exactly one banner shows at a time, and the retry affordance still
 * reaches the layout's drain via the `retry` emit. Mounted against the real
 * `en` catalog so a stale key path would show up as visible copy.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxOfflineBanners from '../PostboxOfflineBanners.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	// The banner renders its copy through vue-i18n; `useI18n` is a Nuxt auto-import.
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const iconStub = { props: ['name'], template: '<span />' };

function mountBanners(props: { isOffline: boolean; queuedCount: number; failedCount: number }) {
	return mount(PostboxOfflineBanners, {
		props,
		global: { plugins: [createTestI18n()], stubs: { Icon: iconStub } },
	});
}

describe('PostboxOfflineBanners', () => {
	it('renders nothing while online with an empty queue', () => {
		const wrapper = mountBanners({ isOffline: false, queuedCount: 0, failedCount: 0 });
		expect(wrapper.text()).toBe('');
	});

	it('states the offline reason, and the queue depth once sends are waiting', () => {
		const quiet = mountBanners({ isOffline: true, queuedCount: 0, failedCount: 0 });
		expect(quiet.text()).toContain('Offline');
		expect(quiet.text()).not.toContain('queued)');

		const queued = mountBanners({ isOffline: true, queuedCount: 2, failedCount: 0 });
		expect(queued.text()).toContain('(2 queued)');
	});

	it('surfaces post-drain failures with a retry, but only once back online', async () => {
		const offline = mountBanners({ isOffline: true, queuedCount: 0, failedCount: 3 });
		// The offline notice wins: the drain has not run yet.
		expect(offline.text()).toContain('Offline');
		expect(offline.find('button').exists()).toBe(false);

		const wrapper = mountBanners({ isOffline: false, queuedCount: 0, failedCount: 3 });
		expect(wrapper.text()).toContain("3 queued messages couldn't be sent");
		await wrapper.get('button').trigger('click');
		expect(wrapper.emitted('retry')).toHaveLength(1);
	});
});
