import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, shallowRef } from 'vue';
import { useToast } from '@owlat/ui/composables/useToast';
import { createTestI18n } from '~/__tests__/i18n';
import { withSetup } from '~/__tests__/withSetup';
import { useAnnounce } from '../useAnnounce';
import { groupSlowOperations, useBackendStatusNotices } from '../useBackendStatusNotices';
import {
	attachBackendConnection,
	CONNECTION_GRACE_MS,
	resetBackendConnection,
	type ConnectionSource,
} from '~/lib/backendConnection';
import {
	registerUnsavedWorkProbe,
	resetPendingOperations,
	SLOW_OPERATION_MS,
	trackPendingOperation,
} from '~/lib/pendingOperations';

const i18n = createTestI18n();
const en = (key: string) => i18n.global.t(key);

let rollout: ReturnType<typeof shallowRef<{ startedAt: number } | null | undefined>>;

function socket() {
	let state = { isWebSocketConnected: true, hasEverConnected: true };
	const listeners = new Set<(s: typeof state) => void>();
	const source: ConnectionSource = {
		connectionState: () => state,
		subscribeToConnectionState: (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	};
	attachBackendConnection(source);
	return (connected: boolean) => {
		state = { ...state, isWebSocketConnected: connected };
		for (const cb of listeners) cb(state);
	};
}

const toastMessages = () => useToast().toasts.value.map((toast) => toast.message);
const warning = () =>
	useToast().toasts.value.find((toast) => toast.message === en('shared.backendStatus.slowSave'));

beforeEach(() => {
	vi.useFakeTimers();
	rollout = shallowRef(undefined);
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', useToast);
	vi.stubGlobal('useAnnounce', useAnnounce);
	vi.stubGlobal('useConvexQuery', () => ({ data: rollout }));
	useAnnounce().clear();
	useToast().clearToasts();
});
const mounted: Array<() => void> = [];
afterEach(() => {
	for (const unmount of mounted.splice(0)) unmount();
	resetPendingOperations();
	resetBackendConnection();
	useToast().clearToasts();
	vi.useRealTimers();
});

function mountNotices() {
	const mountedNotices = withSetup(() => useBackendStatusNotices());
	mounted.push(mountedNotices.unmount);
	return mountedNotices;
}

describe('slow-save notice', () => {
	it('shows nothing before five seconds and one warning after, however many writes wait', async () => {
		mountNotices();
		trackPendingOperation(() => 'Archive');
		trackPendingOperation(() => 'Archive');
		trackPendingOperation(() => 'Rename label');

		vi.advanceTimersByTime(SLOW_OPERATION_MS - 1);
		await nextTick();
		expect(warning()).toBeUndefined();

		vi.advanceTimersByTime(1);
		await nextTick();
		expect(toastMessages().filter((m) => m === en('shared.backendStatus.slowSave'))).toHaveLength(
			1
		);
		expect(warning()?.type).toBe('warning');
		expect(warning()?.action?.label).toBe(en('shared.backendStatus.details'));
	});

	it('Details opens the dialog listing what waits, grouped, and the warning returns when it closes', async () => {
		const { result } = mountNotices();
		trackPendingOperation(() => 'Archive');
		trackPendingOperation(() => 'Archive');
		trackPendingOperation(() => 'Rename label');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		await nextTick();

		const toast = warning()!;
		toast.action!.onAction();
		useToast().dismissAfterAction(toast.id);
		await nextTick();

		expect(result.detailsOpen.value).toBe(true);
		expect(warning()).toBeUndefined();
		expect(result.groups.value.map((g) => [g.label, g.count])).toEqual([
			['Archive', 2],
			['Rename label', 1],
		]);

		result.detailsOpen.value = false;
		await nextTick();
		expect(warning()).toBeDefined();
	});

	it('closing the warning silences it for the rest of the episode', async () => {
		mountNotices();
		const first = trackPendingOperation(() => 'Archive');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		await nextTick();
		useToast().removeToast(warning()!.id);

		trackPendingOperation(() => 'Archive');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		await nextTick();
		expect(warning()).toBeUndefined();

		first(true);
		await nextTick();
		expect(warning()).toBeUndefined();
	});

	it('a reconnect alone confirms nothing; the landed writes do, once', async () => {
		const setConnected = socket();
		mountNotices();
		setConnected(false);
		const settle = trackPendingOperation(() => 'Archive');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		await nextTick();

		setConnected(true);
		await nextTick();
		expect(toastMessages()).not.toContain(en('shared.backendStatus.allSaved'));
		expect(warning()).toBeDefined();

		settle(true);
		await nextTick();
		expect(warning()).toBeUndefined();
		expect(toastMessages().filter((m) => m === en('shared.backendStatus.allSaved'))).toHaveLength(
			1
		);
	});

	it('a failed write ends the episode without a success message', async () => {
		mountNotices();
		const settle = trackPendingOperation(() => 'Archive');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		await nextTick();

		settle(false);
		await nextTick();

		expect(warning()).toBeUndefined();
		expect(toastMessages()).not.toContain(en('shared.backendStatus.allSaved'));
	});

	it('says nothing is saved while another queue still holds unsent work', async () => {
		const unregister = registerUnsavedWorkProbe(() => true);
		try {
			mountNotices();
			const settle = trackPendingOperation(() => 'Archive');
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			await nextTick();
			settle(true);
			await nextTick();

			expect(warning()).toBeUndefined();
			expect(toastMessages()).not.toContain(en('shared.backendStatus.allSaved'));
		} finally {
			unregister();
		}
	});

	it('unmounting takes the warning down and stops listening', async () => {
		const { unmount } = mountNotices();
		const settle = trackPendingOperation(() => 'Archive');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		await nextTick();

		unmount();
		expect(warning()).toBeUndefined();
		settle(true);
		await nextTick();
		expect(toastMessages()).not.toContain(en('shared.backendStatus.allSaved'));
	});
});

describe('connection announcements and rollout evidence', () => {
	it('announces a sustained drop once and the recovery once', async () => {
		const setConnected = socket();
		mountNotices();
		const { politeMessage } = useAnnounce();

		setConnected(false);
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);
		await nextTick();
		expect(politeMessage.value.trim()).toBe(en('shared.backendStatus.reconnectingHint'));

		setConnected(true);
		await nextTick();
		expect(politeMessage.value.trim()).toBe(en('shared.backendStatus.reconnected'));
	});

	it('feeds the open update run into the indicator, and keeps it while the query resets', async () => {
		const setConnected = socket();
		const { result } = mountNotices();
		rollout.value = { startedAt: Date.now() };
		await nextTick();
		// A reset subscription (new identity, auth loss) reads undefined: no answer, not "no update".
		rollout.value = undefined;
		await nextTick();

		setConnected(false);
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);
		await nextTick();

		expect(result.phase.value).toBe('updating');
		expect(result.hint.value).toBe(en('shared.backendStatus.updatingHint'));
	});

	it('a closed run clears the evidence', async () => {
		const setConnected = socket();
		const { result } = mountNotices();
		rollout.value = { startedAt: Date.now() };
		await nextTick();
		rollout.value = null;
		await nextTick();

		setConnected(false);
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);
		await nextTick();

		expect(result.phase.value).toBe('reconnecting');
	});
});

describe('groupSlowOperations', () => {
	it('groups by label, oldest first, with the oldest start per group', () => {
		expect(
			groupSlowOperations([
				{ id: 1, label: 'Rename', startedAt: 30 },
				{ id: 2, label: 'Archive', startedAt: 20 },
				{ id: 3, label: 'Archive', startedAt: 10 },
			])
		).toEqual([
			{ label: 'Archive', count: 2, since: 10 },
			{ label: 'Rename', count: 1, since: 30 },
		]);
	});
});
