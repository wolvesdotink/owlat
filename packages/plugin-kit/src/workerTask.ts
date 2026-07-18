import { isPluginId, type PluginId } from './pluginId';

/**
 * Capability a plugin must declare (and the operator must grant) to enqueue work
 * onto the Tier-3 sandboxed worker queue. Enqueue is the ONLY thing a plugin can
 * do to the queue: it can add background compute, but it can never claim, cancel,
 * or read another plugin's jobs — those are host/operator operations. Like every
 * other contribution capability, the host rechecks manifest declaration + flag +
 * operator grant in the enqueue transaction, so a disabled or ungranted plugin
 * cannot enqueue.
 */
export const PLUGIN_WORKER_CAPABILITY = 'worker:enqueue' as const;

export type PluginWorkerCapability = typeof PLUGIN_WORKER_CAPABILITY;

/**
 * Retry ceiling the host clamps every enqueue to. A job runs at least once and at
 * most this many times across worker attempts (crash-reclaim included), so a
 * poison job can never loop forever and a plugin can never request unbounded
 * retries. Failures past the ceiling terminate the job as `failed`.
 */
export const PLUGIN_WORKER_MIN_ATTEMPTS = 1;
export const PLUGIN_WORKER_MAX_ATTEMPTS = 5;

/**
 * Host-enforced wall-clock bounds for a single job execution. The worker kills
 * the whole job process group when the deadline is hit (fail-closed), so a job
 * cannot pin the sandbox's CPU/memory past its declared budget. Mirrors the cron
 * timeout envelope.
 */
export const PLUGIN_WORKER_TIMEOUT_MIN_MS = 1_000;
export const PLUGIN_WORKER_TIMEOUT_MAX_MS = 15 * 60_000; // 900000 (fifteen minutes)

/**
 * Byte ceiling for the untrusted job payload accepted at enqueue and for the
 * untrusted result stored on completion. Plugin-produced text is untrusted, so
 * both are size-clamped: an oversized payload is rejected at enqueue and an
 * oversized result is truncated before it is persisted.
 */
export const PLUGIN_WORKER_PAYLOAD_MAX_BYTES = 64 * 1024; // 65536
export const PLUGIN_WORKER_RESULT_MAX_BYTES = 64 * 1024; // 65536

/** Local job identity within a plugin. The host namespaces it with the plugin id. */
export type PluginWorkerJobLocalId = string;

/**
 * Collision-safe job kind used as the queue's routing key. Namespacing every job
 * with its owning plugin id is what lets the host reject a cross-plugin enqueue
 * (a plugin trying to run another plugin's job kind) purely from the string.
 */
export type PluginWorkerJobKind = `plugin.${PluginId}.${PluginWorkerJobLocalId}`;

const WORKER_JOB_LOCAL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WORKER_JOB_LOCAL_ID_MAX_LENGTH = 64;

export function pluginWorkerJobKind(
	pluginId: PluginId,
	localId: PluginWorkerJobLocalId
): PluginWorkerJobKind {
	return `plugin.${pluginId}.${localId}`;
}

/** True iff `localId` is a valid, namespacing-safe local job identity. */
export function isPluginWorkerJobLocalId(value: unknown): value is PluginWorkerJobLocalId {
	return (
		typeof value === 'string' &&
		value.length <= WORKER_JOB_LOCAL_ID_MAX_LENGTH &&
		WORKER_JOB_LOCAL_ID.test(value)
	);
}

/**
 * True iff `kind` is exactly `plugin.<pluginId>.<localId>` for the given plugin
 * with a well-formed local id. The host calls this at enqueue so a plugin can
 * only ever enqueue its OWN job kinds — an attempt to enqueue
 * `plugin.other-plugin.job` fails this check and is denied.
 */
export function isPluginWorkerJobKindOwnedBy(
	kind: unknown,
	pluginId: PluginId
): kind is PluginWorkerJobKind {
	if (typeof kind !== 'string') return false;
	const prefix = `plugin.${pluginId}.`;
	if (!kind.startsWith(prefix)) return false;
	return isPluginWorkerJobLocalId(kind.slice(prefix.length));
}

/**
 * Extract the local job id from a namespaced worker job kind, or null when the
 * kind is not exactly `plugin.<pluginId>.<localId>` with a well-formed plugin id
 * and local id. This is the SINGLE authority for parsing a job kind: the host
 * uses `isPluginWorkerJobKindOwnedBy` at enqueue and the sandbox worker uses this
 * to route a claimed job, so the two can never disagree on which kinds are
 * well-formed (both reuse `isPluginId` / `isPluginWorkerJobLocalId`).
 */
export function pluginWorkerJobLocalIdOf(kind: unknown): PluginWorkerJobLocalId | null {
	if (typeof kind !== 'string') return null;
	// A plugin id and a local id both forbid `.`, so a well-formed kind splits
	// into exactly three segments: the `plugin` tag, the plugin id, the local id.
	const parts = kind.split('.');
	if (parts.length !== 3 || parts[0] !== 'plugin') return null;
	const [, pluginId, localId] = parts;
	if (!isPluginId(pluginId)) return null;
	if (!isPluginWorkerJobLocalId(localId)) return null;
	return localId;
}

/**
 * Conformance vectors shared by the plugin-kit and code-worker test suites: a
 * job kind mapped to the local id `pluginWorkerJobLocalIdOf` must return (or null
 * when the kind is malformed). Exported so both sides assert the SAME grammar
 * against the SAME function and cannot drift apart.
 */
export const PLUGIN_WORKER_JOB_KIND_LOCAL_ID_CASES: ReadonlyArray<{
	readonly kind: string;
	readonly localId: PluginWorkerJobLocalId | null;
}> = Object.freeze([
	{ kind: 'plugin.deliverability-lab.spam-score', localId: 'spam-score' },
	{ kind: 'plugin.lab.selftest', localId: 'selftest' },
	{ kind: 'plugin.a.b', localId: 'b' },
	{ kind: 'plugin.x9-y.z9-w', localId: 'z9-w' },
	{ kind: 'plugin.lab.Bad', localId: null },
	{ kind: 'plugin.lab.', localId: null },
	{ kind: 'plugin.lab.a.b', localId: null },
	{ kind: 'plugin.Lab.job', localId: null },
	{ kind: 'plugin.lab.has_underscore', localId: null },
	{ kind: 'plugin..job', localId: null },
	{ kind: 'deliverability-lab.seed-test', localId: null },
	{ kind: 'notplugin.lab.job', localId: null },
	{ kind: 'nope', localId: null },
]);

/** Clamp a requested attempt budget into the host's closed retry range. */
export function clampWorkerAttempts(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested)) return PLUGIN_WORKER_MIN_ATTEMPTS;
	const whole = Math.floor(requested);
	if (whole < PLUGIN_WORKER_MIN_ATTEMPTS) return PLUGIN_WORKER_MIN_ATTEMPTS;
	if (whole > PLUGIN_WORKER_MAX_ATTEMPTS) return PLUGIN_WORKER_MAX_ATTEMPTS;
	return whole;
}

/** Clamp a requested per-execution timeout into the host's closed wall-clock range. */
export function clampWorkerTimeoutMs(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested)) return PLUGIN_WORKER_TIMEOUT_MAX_MS;
	const whole = Math.floor(requested);
	if (whole < PLUGIN_WORKER_TIMEOUT_MIN_MS) return PLUGIN_WORKER_TIMEOUT_MIN_MS;
	if (whole > PLUGIN_WORKER_TIMEOUT_MAX_MS) return PLUGIN_WORKER_TIMEOUT_MAX_MS;
	return whole;
}
