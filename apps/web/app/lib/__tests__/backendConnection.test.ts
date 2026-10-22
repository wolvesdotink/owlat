import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	attachBackendConnection,
	backendConnectionPhase,
	CONNECTION_GRACE_MS,
	forgetRolloutActivity,
	reportRolloutActivity,
	resetBackendConnection,
	ROLLOUT_ACTIVITY_FRESH_MS,
	ROLLOUT_EVIDENCE_MAX_AGE_MS,
	ROLLOUT_HEARTBEAT_MS,
	type ConnectionSource,
} from '../backendConnection';

type SocketState = { isWebSocketConnected: boolean; hasEverConnected: boolean };

/** A stand-in for the Convex client's connection-state surface. */
function fakeSource(initial: SocketState) {
	let state = initial;
	const listeners = new Set<(s: SocketState) => void>();
	const source: ConnectionSource = {
		connectionState: () => state,
		subscribeToConnectionState: (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	};
	return {
		source,
		listenerCount: () => listeners.size,
		set(next: Partial<SocketState>) {
			state = { ...state, ...next };
			for (const cb of listeners) cb(state);
		},
	};
}

const CONNECTED = { isWebSocketConnected: true, hasEverConnected: true };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-22T09:00:00Z'));
});
afterEach(() => {
	resetBackendConnection();
	vi.useRealTimers();
});

describe('backend connection phase', () => {
	it('stays quiet through a drop shorter than the grace period', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS - 1);
		socket.set({ isWebSocketConnected: true });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS * 2);

		expect(backendConnectionPhase.value).toBeNull();
	});

	it('reports a sustained drop as reconnecting, whatever navigator.onLine says', () => {
		// The browser still believes it is online: the socket is the evidence.
		expect(navigator.onLine).not.toBe(false);
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('does not restart the grace period on every state change while down', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS - 500);
		// The client reports retries and in-flight counts while it is down.
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(500);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('clears at once on reconnect', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		socket.set({ isWebSocketConnected: true });

		expect(backendConnectionPhase.value).toBeNull();
	});

	it('says connecting when the socket never opened since the page loaded', () => {
		const socket = fakeSource({ isWebSocketConnected: false, hasEverConnected: false });
		attachBackendConnection(socket.source);

		expect(backendConnectionPhase.value).toBeNull();
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);
		expect(backendConnectionPhase.value).toBe('connecting');

		socket.set({ isWebSocketConnected: true, hasEverConnected: true });
		expect(backendConnectionPhase.value).toBeNull();
	});

	it('detaching unsubscribes and forgets the state', () => {
		const socket = fakeSource(CONNECTED);
		const detach = attachBackendConnection(socket.source);
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		detach();

		expect(socket.listenerCount()).toBe(0);
		expect(backendConnectionPhase.value).toBeNull();
	});

	it('attaching a new client drops the previous subscription', () => {
		const first = fakeSource(CONNECTED);
		const second = fakeSource(CONNECTED);
		attachBackendConnection(first.source);
		attachBackendConnection(second.source);

		expect(first.listenerCount()).toBe(0);
		expect(second.listenerCount()).toBe(1);
	});
});

/**
 * The rollout as this tab sees it while connected: the run opens (no run, then
 * a value) and each heartbeat moves the value on.
 */
function liveRollout() {
	let activeAt = Date.now();
	reportRolloutActivity(null);
	reportRolloutActivity(activeAt);
	return {
		beat() {
			activeAt += ROLLOUT_HEARTBEAT_MS;
			reportRolloutActivity(activeAt);
		},
	};
}

describe('update in progress', () => {
	it('names a drop during a rollout this tab saw active', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		liveRollout();
		expect(backendConnectionPhase.value).toBeNull();

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('updating');
	});

	it('counts a heartbeat seen after load, not the first answer', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		// A page loaded mid-rollout: the first answer proves nothing yet.
		reportRolloutActivity(Date.now() - 10_000);
		reportRolloutActivity(Date.now());

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('updating');
	});

	it('ignores an open run whose activity never moves (an orphaned row)', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		// Recent by its own timestamp, but this tab never saw it advance.
		reportRolloutActivity(Date.now() - 1_000);
		reportRolloutActivity(Date.now() - 1_000);

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('stops trusting a rollout whose heartbeats stopped (its tab closed)', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		const rollout = liveRollout();
		rollout.beat();
		vi.advanceTimersByTime(ROLLOUT_ACTIVITY_FRESH_MS + 1);

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('keeps the claim for the whole drop it was made for', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		liveRollout();
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);
		vi.advanceTimersByTime(5 * 60_000);

		expect(backendConnectionPhase.value).toBe('updating');
	});

	it('ages the claim out to plain reconnecting, even mid-drop', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		liveRollout();
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);
		expect(backendConnectionPhase.value).toBe('updating');

		vi.advanceTimersByTime(ROLLOUT_EVIDENCE_MAX_AGE_MS);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('a later drop without fresh activity is not the update', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		liveRollout();
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);
		socket.set({ isWebSocketConnected: true });
		expect(backendConnectionPhase.value).toBeNull();

		// The row stays open (nobody closed it) and no heartbeat comes.
		vi.advanceTimersByTime(ROLLOUT_ACTIVITY_FRESH_MS + 1);
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('drops the update claim once the run is reported closed', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		liveRollout();
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		reportRolloutActivity(null);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('takes the first answer after gaining visibility as a baseline, not a run opening', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		// Signed out: the query hides rollouts. Signing in reveals a row orphaned
		// a day ago, which this tab never saw advance.
		forgetRolloutActivity();
		reportRolloutActivity(Date.now() - 24 * 60 * 60_000);

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('counts a heartbeat seen after visibility was gained', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		forgetRolloutActivity();
		reportRolloutActivity(Date.now() - 10_000);
		reportRolloutActivity(Date.now());

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('updating');
	});

	it('losing visibility forgets live evidence and the next answer is a baseline again', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		liveRollout();
		forgetRolloutActivity();
		reportRolloutActivity(Date.now() - 1_000);

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('never claims an update for a socket that has not connected yet', () => {
		const socket = fakeSource({ isWebSocketConnected: false, hasEverConnected: false });
		attachBackendConnection(socket.source);
		liveRollout();
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('connecting');
	});
});
