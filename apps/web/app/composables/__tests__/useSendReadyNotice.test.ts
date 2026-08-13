/**
 * THE ONCE-EVER NOTICE MUST SURVIVE BEING IGNORED.
 *
 * `sendReadyNotices` is acknowledged server-side and never written again for
 * that member: this toast is their only telling that the instance can send now
 * and their blocked onboarding step is open. So the two failure modes worth
 * pinning are both about spending it on nobody — a toast that disappears on a
 * three-second timer while the member is reading something else, and an
 * acknowledge that fires the instant it renders rather than when they actually
 * deal with it. Sticky + acknowledge-on-dismissal is the contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import type { ToastOptions } from '@owlat/ui/composables/useToast';
import { SEND_READY_DEEP_LINK } from '~/lib/onboarding/sendReadyNotice';
import { useSendReadyNotice } from '../useSendReadyNotice';

interface NoticeState {
	isReady: boolean;
	notices: Array<{ id: string; createdAt: number }>;
}

const state = ref<NoticeState | undefined>(undefined);
const acknowledge = vi.fn();
const showToast = vi.fn();
const navigate = vi.fn();

/** The options the composable handed the toaster on its most recent call. */
function lastToastOptions(): ToastOptions {
	const call = showToast.mock.calls.at(-1);
	if (!call) throw new Error('no toast was shown');
	return call[2] as ToastOptions;
}

// The composable is mounted once from the dashboard layout and torn down with
// it. Standing it up in a scope reproduces that lifetime — without one, every
// test's watcher would keep reacting to the shared state ref.
let scope: EffectScope | null = null;

function mount(): void {
	scope = effectScope();
	scope.run(() => useSendReadyNotice());
}

afterEach(() => {
	scope?.stop();
	scope = null;
});

beforeEach(() => {
	state.value = undefined;
	acknowledge.mockReset();
	showToast.mockReset();
	navigate.mockReset();
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: state,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: acknowledge, isRunning: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('navigateTo', navigate);
});

describe('useSendReadyNotice', () => {
	it('says nothing while there is no pending notice', async () => {
		mount();
		state.value = { isReady: true, notices: [] };
		await nextTick();

		expect(showToast).not.toHaveBeenCalled();
		expect(acknowledge).not.toHaveBeenCalled();
	});

	it('shows a sticky toast that does not acknowledge itself on display', async () => {
		mount();
		state.value = { isReady: true, notices: [{ id: 'n1', createdAt: 10 }] };
		await nextTick();

		expect(showToast).toHaveBeenCalledTimes(1);
		// 0 ⇒ sticky. Anything else is a deadline on a message that never repeats.
		expect(lastToastOptions().durationMs).toBe(0);
		expect(acknowledge).not.toHaveBeenCalled();
	});

	it('acknowledges when the member dismisses it, not before', async () => {
		mount();
		state.value = { isReady: true, notices: [{ id: 'n1', createdAt: 10 }] };
		await nextTick();

		lastToastOptions().onDismiss?.();
		expect(acknowledge).toHaveBeenCalledTimes(1);
		expect(acknowledge).toHaveBeenCalledWith({});
	});

	it('deep-links to the blocked step from the action button', async () => {
		mount();
		state.value = { isReady: true, notices: [{ id: 'n1', createdAt: 10 }] };
		await nextTick();

		const action = lastToastOptions().action;
		expect(action?.label).toBe('Finish setup');
		action?.onAction();
		expect(navigate).toHaveBeenCalledWith(SEND_READY_DEEP_LINK);
	});

	it('toasts once for a burst of notices, and not again while unacknowledged', async () => {
		mount();
		state.value = {
			isReady: true,
			notices: [
				{ id: 'n1', createdAt: 10 },
				{ id: 'n2', createdAt: 20 },
			],
		};
		await nextTick();
		expect(showToast).toHaveBeenCalledTimes(1);

		// The query re-reports the still-pending rows before the acknowledge lands.
		state.value = {
			isReady: true,
			notices: [
				{ id: 'n1', createdAt: 10 },
				{ id: 'n2', createdAt: 20 },
			],
		};
		await nextTick();
		expect(showToast).toHaveBeenCalledTimes(1);
	});
});
