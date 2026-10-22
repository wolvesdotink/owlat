/**
 * The app's one view of whether the backend can be reached.
 *
 * The Convex client owns the WebSocket and its retries; this module only
 * watches it, so there is never a second reconnect loop. `convex.client.ts`
 * attaches the client once, and the shell (sidebar footer, desktop titlebar)
 * renders {@link backendConnectionPhase}.
 *
 * Transport health is all this says. A connected socket is no proof that a save
 * landed (that is `pendingOperations.ts`), and a dropped one is no proof that
 * one failed: the client re-sends in-flight mutations once it is back.
 */
import { readonly, shallowRef } from 'vue';

/**
 * `null`: nothing to report (connected, or no client on this page).
 * `connecting`: the socket has not opened yet since the page loaded.
 * `reconnecting`: it was open and dropped.
 * `updating`: it dropped while an update was rolling out, which restarts the backend.
 */
export type BackendConnectionPhase = 'connecting' | 'reconnecting' | 'updating' | null;

/**
 * How long the socket must stay down before the shell says so. Mobile networks,
 * laptop wake-ups and server deploys drop sockets for a second or two all the
 * time; showing each of those would teach people to ignore the indicator.
 */
export const CONNECTION_GRACE_MS = 3_000;

/**
 * How long an open update run counts as evidence that a drop is the update.
 * The run row can stay open long after its rollout ended (the tab that would
 * have closed it went away), so the evidence ages out instead of being trusted
 * forever. Rollouts pull images, recreate containers and wait for readiness,
 * which stays well inside this bound.
 */
export const ROLLOUT_EVIDENCE_MAX_AGE_MS = 20 * 60_000;

/** The part of `ConvexClient` this module reads. */
export interface ConnectionSource {
	connectionState(): { isWebSocketConnected: boolean; hasEverConnected: boolean };
	subscribeToConnectionState(
		cb: (state: { isWebSocketConnected: boolean; hasEverConnected: boolean }) => void
	): () => void;
}

const phase = shallowRef<BackendConnectionPhase>(null);

/** The shell's connection state; `null` while there is nothing to say. */
export const backendConnectionPhase = readonly(phase);

let socketDown = false;
let everConnected = false;
/** The socket has been down for the whole grace period. */
let dropConfirmed = false;
let graceTimer: ReturnType<typeof setTimeout> | undefined;
/** When the newest open update run started, as last reported while connected. */
let rolloutStartedAt: number | null = null;
let rolloutExpiryTimer: ReturnType<typeof setTimeout> | undefined;

function rolloutIsFresh(now: number): boolean {
	return rolloutStartedAt !== null && now - rolloutStartedAt < ROLLOUT_EVIDENCE_MAX_AGE_MS;
}

function recompute(): void {
	clearTimeout(rolloutExpiryTimer);
	rolloutExpiryTimer = undefined;
	if (!dropConfirmed) {
		phase.value = null;
		return;
	}
	const now = Date.now();
	if (everConnected && rolloutIsFresh(now)) {
		phase.value = 'updating';
		// The evidence expires while the socket is still down: fall back to the
		// plain reconnecting state rather than claiming an update forever.
		rolloutExpiryTimer = setTimeout(
			recompute,
			(rolloutStartedAt as number) + ROLLOUT_EVIDENCE_MAX_AGE_MS - now
		);
		return;
	}
	phase.value = everConnected ? 'reconnecting' : 'connecting';
}

function onSocketState(state: { isWebSocketConnected: boolean; hasEverConnected: boolean }) {
	if (state.hasEverConnected) everConnected = true;
	if (state.isWebSocketConnected) {
		socketDown = false;
		clearTimeout(graceTimer);
		graceTimer = undefined;
		if (dropConfirmed) {
			dropConfirmed = false;
			recompute();
		}
		return;
	}
	if (socketDown) return;
	socketDown = true;
	graceTimer = setTimeout(() => {
		graceTimer = undefined;
		if (!socketDown) return;
		dropConfirmed = true;
		recompute();
	}, CONNECTION_GRACE_MS);
}

let detachCurrent: (() => void) | null = null;

/**
 * Watch `source`'s socket. One source at a time: attaching another detaches the
 * previous one. Returns the detach, which also forgets every observed state.
 */
export function attachBackendConnection(source: ConnectionSource): () => void {
	detachCurrent?.();
	onSocketState(source.connectionState());
	const unsubscribe = source.subscribeToConnectionState(onSocketState);
	const detach = () => {
		unsubscribe();
		if (detachCurrent === detach) detachCurrent = null;
		resetBackendConnection();
	};
	detachCurrent = detach;
	return detach;
}

/**
 * The newest open update run's start, or `null` when none is open. Reported
 * while connected; kept across a drop, because during one nothing new can
 * arrive and the last answer is the evidence.
 */
export function reportRolloutActivity(startedAt: number | null): void {
	if (rolloutStartedAt === startedAt) return;
	rolloutStartedAt = startedAt;
	recompute();
}

/** Forget everything observed. For a detach and for tests. */
export function resetBackendConnection(): void {
	clearTimeout(graceTimer);
	clearTimeout(rolloutExpiryTimer);
	graceTimer = undefined;
	rolloutExpiryTimer = undefined;
	socketDown = false;
	everConnected = false;
	dropConfirmed = false;
	rolloutStartedAt = null;
	phase.value = null;
}
