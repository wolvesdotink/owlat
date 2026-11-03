/**
 * "Owlat was updated": hidden until the watch knows of a newer build, then one
 * notice with Reload and the release's notes. Reload waits on the watch, and
 * says so when something unsaved keeps the page from reloading.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { shallowRef } from 'vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import type { AppVersionWatch, DeployedBuild, ReloadOutcome } from '~/lib/appVersion';

const fake = vi.hoisted(() => ({
	watch: null as AppVersionWatch | null,
}));

vi.mock('~/composables/useAppVersionWatch', () => ({
	useAppVersionWatch: () => fake.watch,
}));

import AppUpdatedBanner from '../AppUpdatedBanner.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

let update: ReturnType<typeof shallowRef<DeployedBuild | null>>;
let start: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let reloadNow: ReturnType<typeof vi.fn<() => Promise<ReloadOutcome>>>;
let wrapper: VueWrapper | null = null;

beforeEach(() => {
	update = shallowRef<DeployedBuild | null>(null);
	stop = vi.fn();
	start = vi.fn(() => stop);
	reloadNow = vi.fn<() => Promise<ReloadOutcome>>(async () => 'reloading');
	fake.watch = { update, start, check: vi.fn(), reloadNow } as unknown as AppVersionWatch;
});
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function mountBanner() {
	wrapper = mount(AppUpdatedBanner, {
		global: { plugins: [createTestI18n()], components: { UiButton } },
	});
	return wrapper;
}

const banner = (w: VueWrapper) => w.find('[data-testid="app-updated-banner"]');

describe('AppUpdatedBanner', () => {
	it('starts the watch on mount, shows nothing until an update is known, and stops on unmount', () => {
		const w = mountBanner();
		expect(start).toHaveBeenCalledTimes(1);
		expect(banner(w).exists()).toBe(false);
		w.unmount();
		wrapper = null;
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it('renders nothing where the watch does not apply', () => {
		fake.watch = null;
		const w = mountBanner();
		expect(banner(w).exists()).toBe(false);
	});

	it('names the release and links its notes in a new tab', async () => {
		const w = mountBanner();
		update.value = { buildId: 'b', version: '0.6.17' };
		await flushPromises();
		const notice = banner(w);
		expect(notice.text()).toContain('Owlat was updated');
		expect(notice.text()).toContain('Reload to use version 0.6.17. Your drafts are kept.');
		const link = notice.get('a');
		expect(link.attributes('href')).toBe(
			'https://github.com/wolvesdotink/owlat/releases/tag/v0.6.17'
		);
		expect(link.attributes('target')).toBe('_blank');
		expect(link.attributes('rel')).toContain('noopener');
		expect(link.text()).toContain("What's new");
		expectFullyLocalized(w);
	});

	it('offers no notes link for a build that is not a release', async () => {
		const w = mountBanner();
		update.value = { buildId: 'b', version: null };
		await flushPromises();
		expect(banner(w).text()).toContain('Reload to use the new version. Your drafts are kept.');
		expect(banner(w).find('a').exists()).toBe(false);
	});

	it('reloads through the watch', async () => {
		const w = mountBanner();
		update.value = { buildId: 'b', version: '0.6.17' };
		await flushPromises();
		await banner(w).get('button.btn').trigger('click');
		await flushPromises();
		expect(reloadNow).toHaveBeenCalledTimes(1);
		expect(banner(w).text()).toContain('Reloading…');
	});

	it('says what keeps the page from reloading, and lets the person try again', async () => {
		reloadNow.mockResolvedValueOnce('blocked');
		const w = mountBanner();
		update.value = { buildId: 'b', version: '0.6.17' };
		await flushPromises();
		await banner(w).get('button.btn').trigger('click');
		await flushPromises();
		expect(w.find('[data-testid="app-updated-blocked"]').text()).toBe(
			'Some changes are not saved yet. Save or finish them, then reload.'
		);

		await banner(w).get('button.btn').trigger('click');
		await flushPromises();
		expect(reloadNow).toHaveBeenCalledTimes(2);
		expect(w.find('[data-testid="app-updated-blocked"]').exists()).toBe(false);
	});

	it('hides when dismissed', async () => {
		const w = mountBanner();
		update.value = { buildId: 'b', version: '0.6.17' };
		await flushPromises();
		await banner(w).get('button[aria-label="Hide this notice"]').trigger('click');
		expect(banner(w).exists()).toBe(false);
	});
});
