import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	attachBackendConnection,
	backendConnectionPhase,
	CONNECTION_GRACE_MS,
	reportRolloutActivity,
	resetBackendConnection,
	ROLLOUT_EVIDENCE_MAX_AGE_MS,
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

describe('update in progress', () => {
	it('names a drop during a recent update run', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		reportRolloutActivity(Date.now() - 60_000);
		expect(backendConnectionPhase.value).toBeNull();

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('updating');
	});

	it('keeps the evidence it had when the socket dropped', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		reportRolloutActivity(Date.now());
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);
		vi.advanceTimersByTime(5 * 60_000);

		expect(backendConnectionPhase.value).toBe('updating');
	});

	it('ages stale evidence out to plain reconnecting, even mid-drop', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		reportRolloutActivity(Date.now());
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);
		expect(backendConnectionPhase.value).toBe('updating');

		vi.advanceTimersByTime(ROLLOUT_EVIDENCE_MAX_AGE_MS);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('ignores an orphaned run that is already older than the bound', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		reportRolloutActivity(Date.now() - ROLLOUT_EVIDENCE_MAX_AGE_MS - 1);

		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('drops the update claim once the run is reported closed', () => {
		const socket = fakeSource(CONNECTED);
		attachBackendConnection(socket.source);
		reportRolloutActivity(Date.now());
		socket.set({ isWebSocketConnected: false });
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		reportRolloutActivity(null);

		expect(backendConnectionPhase.value).toBe('reconnecting');
	});

	it('never claims an update for a socket that has not connected yet', () => {
		const socket = fakeSource({ isWebSocketConnected: false, hasEverConnected: false });
		attachBackendConnection(socket.source);
		reportRolloutActivity(Date.now());
		vi.advanceTimersByTime(CONNECTION_GRACE_MS);

		expect(backendConnectionPhase.value).toBe('connecting');
	});
});
