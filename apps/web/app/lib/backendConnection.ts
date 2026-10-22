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
 * How often the admin tab following an update confirms the rollout is still
 * under way (`systemUpdates.recordUpdateActivity`).
 */
export const ROLLOUT_HEARTBEAT_MS = 30_000;

/**
 * How recently this tab must have seen the rollout's activity advance for a
 * drop to count as the update. Two heartbeats, with room for a background
 * admin tab whose timers the browser throttles to once a minute.
 */
export const ROLLOUT_ACTIVITY_FRESH_MS = 2 * 60_000;

/**
 * How long a drop that began during a confirmed rollout may read "update in
 * progress". Rollouts pull images, recreate containers and wait for readiness,
 * which stays well inside this bound; a backend that is still unreachable
 * after it is not shown as an update any more.
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
let socketDownAt = 0;
let everConnected = false;
/** The socket has been down for the whole grace period. */
let dropConfirmed = false;
/** The confirmed drop began while a rollout was confirmed active. */
let dropIsUpdate = false;
let graceTimer: ReturnType<typeof setTimeout> | undefined;
/** The last rollout activity reported; `undefined` before the first answer. */
let lastActivity: number | null | undefined;
/** This tab's clock when it last saw that activity advance. */
let activitySeenAt: number | null = null;
let rolloutExpiryTimer: ReturnType<typeof setTimeout> | undefined;

function recompute(): void {
	clearTimeout(rolloutExpiryTimer);
	rolloutExpiryTimer = undefined;
	if (!dropConfirmed) {
		phase.value = null;
		return;
	}
	const now = Date.now();
	if (dropIsUpdate && activitySeenAt !== null) {
		const expiresAt = activitySeenAt + ROLLOUT_EVIDENCE_MAX_AGE_MS;
		if (now < expiresAt) {
			phase.value = 'updating';
			// Still down when the bound runs out: fall back to the plain
			// reconnecting state rather than claiming an update forever.
			rolloutExpiryTimer = setTimeout(recompute, expiresAt - now);
			return;
		}
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
			dropIsUpdate = false;
			recompute();
		}
		return;
	}
	if (socketDown) return;
	socketDown = true;
	socketDownAt = Date.now();
	graceTimer = setTimeout(() => {
		graceTimer = undefined;
		if (!socketDown) return;
		dropConfirmed = true;
		// Judged at the moment the socket went down, with this tab's own clock on
		// both sides, so a skewed client clock cannot make old activity look fresh.
		dropIsUpdate =
			everConnected &&
			activitySeenAt !== null &&
			socketDownAt - activitySeenAt <= ROLLOUT_ACTIVITY_FRESH_MS;
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
 * The open update run's last confirmed activity (`activeAt` of
 * `systemUpdates.getRolloutActivity`), or `null` when no run is open.
 *
 * Only a change this tab sees while connected counts as activity: the first
 * answer after a page load cannot tell a live rollout from a row orphaned
 * hours ago, but a live rollout's heartbeat moves the value on within
 * {@link ROLLOUT_HEARTBEAT_MS}, and a run opening while this tab watches turns
 * `null` into a value. Kept across a drop, because during one nothing new can
 * arrive and the last answer is the evidence.
 */
export function reportRolloutActivity(activeAt: number | null): void {
	const previous = lastActivity;
	lastActivity = activeAt;
	if (activeAt === null) {
		if (activitySeenAt === null && !dropIsUpdate) return;
		activitySeenAt = null;
		dropIsUpdate = false;
		recompute();
		return;
	}
	if (previous === undefined || previous === activeAt) return;
	activitySeenAt = Date.now();
}

/** Forget everything observed. For a detach and for tests. */
export function resetBackendConnection(): void {
	clearTimeout(graceTimer);
	clearTimeout(rolloutExpiryTimer);
	graceTimer = undefined;
	rolloutExpiryTimer = undefined;
	socketDown = false;
	socketDownAt = 0;
	everConnected = false;
	dropConfirmed = false;
	dropIsUpdate = false;
	lastActivity = undefined;
	activitySeenAt = null;
	phase.value = null;
}
