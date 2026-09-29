// @vitest-environment happy-dom
/**
 * PostboxSenderControls and PostboxSenderProfile both read the sender's VIP and
 * screener state from `usePostboxSenderState` and render the same answer: an
 * Accept button exactly when the server says the screener holds the sender
 * back, and (in the profile) an "accepted" state when it lets them through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

import PostboxSenderControls from '../PostboxSenderControls.vue';
import PostboxSenderProfile from '../PostboxSenderProfile.vue';

const canAccept = ref(false);
const isAccepted = ref(false);
const toggleVip = vi.fn();
const acceptSender = vi.fn();
const calls: { email: string; enabled: boolean }[] = [];

beforeEach(() => {
	canAccept.value = false;
	isAccepted.value = false;
	toggleVip.mockClear();
	acceptSender.mockClear();
	calls.length = 0;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined) }));
	vi.stubGlobal(
		'usePostboxSenderState',
		(opts: { email: MaybeRefOrGetter<string>; enabled?: MaybeRefOrGetter<boolean> }) => {
			calls.push({ email: toValue(opts.email), enabled: toValue(opts.enabled ?? true) });
			return {
				isVip: computed(() => false),
				canAccept: computed(() => canAccept.value),
				isAccepted: computed(() => isAccepted.value),
				toggleVip,
				acceptSender,
				busy: computed(() => false),
			};
		}
	);
});

const mountGlobal = {
	plugins: [createTestI18n()],
	components: {
		Icon: { props: ['name'], template: '<span />' },
		UiAvatar: { template: '<span />' },
		UiButton: { template: '<button type="button"><slot /></button>' },
		NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
	},
	stubs: { teleport: true },
};

describe('PostboxSenderControls', () => {
	it('passes the bare address and shows Accept only when the sender can be accepted', async () => {
		const w = mount(PostboxSenderControls, {
			props: { mailboxId: 'mb-1', fromAddress: 'Ada <ada@example.com>' },
			global: mountGlobal,
		});
		expect(calls[0]).toEqual({ email: 'ada@example.com', enabled: true });
		expect(w.text()).not.toContain('Accept');

		canAccept.value = true;
		await w.vm.$nextTick();
		const accept = w.findAll('button').find((b) => b.text().includes('Accept'));
		expect(accept).toBeDefined();
		await accept?.trigger('click');
		expect(acceptSender).toHaveBeenCalledOnce();
	});
});

describe('PostboxSenderProfile', () => {
	function mountProfile(open = true) {
		return mount(PostboxSenderProfile, {
			props: { open, mailboxId: 'mb-1', fromAddress: 'Ada <ada@example.com>' },
			global: mountGlobal,
		});
	}

	it('skips the sender state while closed', () => {
		mountProfile(false);
		expect(calls[0]?.enabled).toBe(false);
	});

	it('shows Accept for a screened sender and the accepted state otherwise', async () => {
		const w = mountProfile();
		expect(w.find('[data-testid="sender-screener-accepted"]').exists()).toBe(false);
		expect(w.findAll('button').some((b) => b.text().includes('Accept'))).toBe(false);

		canAccept.value = true;
		await w.vm.$nextTick();
		expect(w.findAll('button').some((b) => b.text().includes('Accept'))).toBe(true);

		canAccept.value = false;
		isAccepted.value = true;
		await w.vm.$nextTick();
		expect(w.findAll('button').some((b) => b.text().includes('Accept'))).toBe(false);
		expect(w.find('[data-testid="sender-screener-accepted"]').exists()).toBe(true);
	});
});
