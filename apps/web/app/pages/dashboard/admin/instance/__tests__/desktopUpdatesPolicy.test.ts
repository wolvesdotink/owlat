// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

import DesktopUpdatesPage from '../desktop-updates.vue';
import { useDesktopUpdatePolicy } from '~/composables/useDesktopUpdatePolicy';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * The desktop update policy page.
 *
 * Three things here are load-bearing and nothing else on the page tells you if
 * they break:
 *  - the pin picker may only offer releases this instance has CACHED, because
 *    `updatePolicy` refuses a pin to anything else — a picker that got ahead of
 *    the cache would turn an ordinary save into a backend error;
 *  - the save has to carry the whole policy, since `updatePolicy` REPLACES the
 *    stored object: an omitted defer window clears it, and a mode change away
 *    from `pinned` has to drop the pin rather than leave it hanging;
 *  - the write floor is `settings:manage`, and the page's job is to say so
 *    before the backend has to.
 */

const i18n = createTestI18n();
Object.assign(globalThis, { useI18n: () => i18n.global });

type Release = {
	version: string;
	tag: string;
	line: 'unified' | 'desktop';
	isPrerelease: boolean;
	publishedAt: number;
	notes: string;
};

const PUBLISHED = Date.UTC(2026, 8, 14, 9, 0, 0);

const CACHED: Release[] = [
	{
		version: '0.5.0-rc.1',
		tag: 'v0.5.0-rc.1',
		line: 'unified',
		isPrerelease: true,
		publishedAt: PUBLISHED + 3_600_000,
		notes: 'Release candidate.',
	},
	{
		version: '0.4.7',
		tag: 'desktop-v0.4.7',
		line: 'desktop',
		isPrerelease: false,
		publishedAt: PUBLISHED,
		notes: 'Fixes the tray icon.',
	},
	{
		version: '0.4.6',
		tag: 'v0.4.6',
		line: 'unified',
		isPrerelease: false,
		publishedAt: PUBLISHED - 86_400_000,
		notes: '',
	},
];

const policy = ref<unknown>(null);
const releases = ref<Release[]>([]);
const canManageSettings = ref(true);
const savePolicy = vi.fn();
const checkNow = vi.fn();
const showToast = vi.fn();

function storedPolicy(overrides: Record<string, unknown> = {}) {
	return {
		policy: { mode: 'latest', channel: 'stable', ...overrides },
		check: { checkedAt: PUBLISHED + 7_200_000, error: null },
		lastChange: { at: PUBLISHED, by: 'Marcel' },
	};
}

let queryCall = 0;
let operationCall = 0;

beforeAll(() => {
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('usePermissions', () => ({ canManageSettings }));
	// The page reaches the backend only through this composable, so the real one
	// runs here and the two Convex seams underneath it are what gets stubbed.
	vi.stubGlobal('useDesktopUpdatePolicy', useDesktopUpdatePolicy);
	vi.stubGlobal('useConvexQuery', () => {
		const call = queryCall++ % 2;
		if (call === 0) return { data: policy, isLoading: ref(false), error: ref(null) };
		return { data: releases, isLoading: ref(false), error: ref(null) };
	});
	vi.stubGlobal('useBackendOperation', () => {
		const call = operationCall++ % 2;
		return { run: call === 0 ? savePolicy : checkNow, isLoading: ref(false) };
	});
});

beforeEach(() => {
	queryCall = 0;
	operationCall = 0;
	policy.value = storedPolicy();
	releases.value = CACHED;
	canManageSettings.value = true;
	savePolicy.mockReset().mockResolvedValue({ ok: true, result: {} });
	checkNow.mockReset().mockResolvedValue({ ok: true, result: { checkedAt: 1, error: null } });
	showToast.mockReset();
});

const passthroughStub = { template: '<div><slot name="header"/><slot/></div>' };
const buttonStub = {
	props: ['disabled', 'loading', 'variant', 'size'],
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot/></button>',
};

const emptyStateStub = {
	props: ['icon', 'title', 'description'],
	template: '<div><p>{{ title }}</p><p>{{ description }}</p><slot/></div>',
};

const stubs = {
	UiQueryBoundary: passthroughStub,
	UiCard: passthroughStub,
	UiEmptyState: emptyStateStub,
	UiButton: buttonStub,
	Icon: true,
	NuxtLink: true,
};

function mountPage() {
	return mount(DesktopUpdatesPage, { global: { plugins: [i18n], stubs } });
}

const MODE_PINNED = '[data-testid="desktop-updates-mode-pinned"]';
const MODE_PAUSED = '[data-testid="desktop-updates-mode-paused"]';
const CHANNEL_PRERELEASE = '[data-testid="desktop-updates-channel-prerelease"]';
const CHANNEL_STABLE = '[data-testid="desktop-updates-channel-stable"]';
const PIN = '[data-testid="desktop-updates-pin"]';
const DEFER = '[data-testid="desktop-updates-defer"]';
const SAVE = '[data-testid="desktop-updates-save"]';
const CHECK = '[data-testid="desktop-updates-check-now"]';

function pinOptions(wrapper: ReturnType<typeof mountPage>): string[] {
	return wrapper
		.find(PIN)
		.findAll('option')
		.map((option) => option.element.value)
		.filter((value) => value !== '');
}

describe('Desktop updates — the pin picker', () => {
	it('offers only the cached releases, and only the ones on the channel', async () => {
		const wrapper = mountPage();
		await wrapper.find(MODE_PINNED).setValue();

		// 0.5.0-rc.1 is cached but pre-release, so the stable channel cannot see it.
		expect(pinOptions(wrapper)).toEqual(['0.4.7', '0.4.6']);

		await wrapper.find(CHANNEL_PRERELEASE).setValue();
		expect(pinOptions(wrapper)).toEqual(['0.5.0-rc.1', '0.4.7', '0.4.6']);
	});

	it('drops a pinned pre-release when the channel goes back to stable', async () => {
		policy.value = storedPolicy({
			mode: 'pinned',
			channel: 'prerelease',
			pinnedVersion: '0.5.0-rc.1',
		});
		const wrapper = mountPage();
		expect((wrapper.find(PIN).element as HTMLSelectElement).value).toBe('0.5.0-rc.1');

		await wrapper.find(CHANNEL_STABLE).setValue();

		// The stable channel cannot see the rc, so the pin is gone rather than
		// submitted invisibly: the save button waits for a new choice.
		expect((wrapper.find(PIN).element as HTMLSelectElement).value).toBe('');
		expect(wrapper.find(SAVE).attributes('disabled')).toBeDefined();
	});

	it('names the newest cached release and its line', () => {
		const wrapper = mountPage();
		const newest = wrapper.find('[data-testid="desktop-updates-newest"]');
		expect(newest.text()).toBe('0.4.7');
		expect(wrapper.text()).toContain('desktop-only line');
	});

	it('says the cache is empty and offers the poll that fills it', () => {
		releases.value = [];
		const wrapper = mountPage();

		expect(wrapper.find('[data-testid="desktop-updates-releases"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="desktop-updates-empty"]').text()).toContain(
			'No releases cached yet'
		);
	});

	it('surfaces the recorded error from a failed poll', () => {
		policy.value = {
			...storedPolicy(),
			check: { checkedAt: PUBLISHED, error: 'rate_limited' },
		};
		const wrapper = mountPage();

		expect(wrapper.find('[data-testid="desktop-updates-check-error"]').text()).toContain(
			'rate_limited'
		);
	});
});

describe('Desktop updates — saving the policy', () => {
	it('sends the pin, the channel and the defer window together', async () => {
		const wrapper = mountPage();
		await wrapper.find(MODE_PINNED).setValue();
		await wrapper.find(PIN).setValue('0.4.6');
		await wrapper.find(DEFER).setValue(24);

		await wrapper.find(SAVE).trigger('click');
		await flushPromises();

		expect(savePolicy).toHaveBeenCalledWith({
			mode: 'pinned',
			channel: 'stable',
			pinnedVersion: '0.4.6',
			requiredVersion: undefined,
			deferHours: 24,
		});
		expect(showToast).toHaveBeenCalledWith('Desktop update policy saved.');
	});

	it('drops the pin when the mode moves away from pinned, and keeps the floor', async () => {
		policy.value = storedPolicy({
			mode: 'pinned',
			pinnedVersion: '0.4.6',
			requiredVersion: '0.4.0',
			deferHours: 12,
		});
		const wrapper = mountPage();
		await wrapper.find(MODE_PAUSED).setValue();

		await wrapper.find(SAVE).trigger('click');
		await flushPromises();

		expect(savePolicy).toHaveBeenCalledWith({
			mode: 'paused',
			channel: 'stable',
			pinnedVersion: undefined,
			// `requiredVersion` has no control on this page and `updatePolicy`
			// replaces the whole object — carrying it through is what stops a save
			// from silently clearing a floor.
			requiredVersion: '0.4.0',
			deferHours: 12,
		});
	});

	it('refuses to save a pin that has not been chosen', async () => {
		const wrapper = mountPage();
		await wrapper.find(MODE_PINNED).setValue();

		expect(wrapper.find(SAVE).attributes('disabled')).toBeDefined();
		await wrapper.find(SAVE).trigger('click');
		expect(savePolicy).not.toHaveBeenCalled();
	});

	it('refuses a defer window past the week the backend allows', async () => {
		const wrapper = mountPage();
		await wrapper.find(DEFER).setValue(200);

		expect(wrapper.find('[data-testid="desktop-updates-defer-error"]').text()).toContain(
			'0 to 168'
		);
		expect(wrapper.find(SAVE).attributes('disabled')).toBeDefined();
	});

	it('prints who last changed the policy', () => {
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="desktop-updates-audit"]').text()).toContain(
			'Last changed by Marcel'
		);
	});
});

describe('Desktop updates — the settings:manage floor', () => {
	it('disables every write control for a member without it', () => {
		canManageSettings.value = false;
		const wrapper = mountPage();

		expect(wrapper.text()).toContain('You can read this policy but not change it');
		for (const selector of [MODE_PINNED, MODE_PAUSED, CHANNEL_PRERELEASE, DEFER]) {
			expect(wrapper.find(selector).attributes('disabled')).toBeDefined();
		}
		expect(wrapper.find(SAVE).attributes('disabled')).toBeDefined();
		expect(wrapper.find(CHECK).attributes('disabled')).toBeDefined();
	});

	it('leaves the same controls live for an admin', async () => {
		const wrapper = mountPage();

		expect(wrapper.find(MODE_PINNED).attributes('disabled')).toBeUndefined();
		expect(wrapper.find(CHECK).attributes('disabled')).toBeUndefined();

		await wrapper.find(CHECK).trigger('click');
		await flushPromises();
		expect(checkNow).toHaveBeenCalledWith({});
	});
});
