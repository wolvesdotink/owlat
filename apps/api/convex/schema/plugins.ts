import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { languageEndpointProvenanceValidator } from '../lib/aiProviderConfigValidators';

/** Host-mediated plugin data; Tier-1 component tables remain component-local. */
export const pluginTables = {
	// Tier-2 connected apps: external services bound to one bundled plugin,
	// reachable at a signed endpoint. One row per registered app, tenant-scoped
	// by organizationId. The shared hook-signing secret lives ONLY as an
	// AES-256-GCM envelope (see connectedApps/secretBox.ts) — never in plaintext,
	// never returned after the one-time reveal at register/rotate.
	connectedApps: defineTable({
		organizationId: v.string(),
		// The bundled plugin this app is the external half of. Its manifest bounds
		// the capabilities the app may be granted; runtime authorizers re-check the
		// operator grant so the grant here can only ever RESTRICT, never widen.
		pluginId: v.string(),
		name: v.string(),
		// HTTPS endpoint that receives signed synchronous hooks (PP-24). Validated
		// at write time; network-level SSRF enforcement lands with the hook fetch.
		endpointUrl: v.string(),
		status: v.union(v.literal('enabled'), v.literal('disabled'), v.literal('revoked')),
		// Restrict-only subset of the plugin manifest capabilities this app requests.
		grantedCapabilities: v.array(v.string()),
		// Sealed hook-signing secret (AES-256-GCM). Retained after revoke for audit
		// history but cryptographically dead — a revoked app can never re-enable.
		secretCiphertext: v.string(),
		secretIv: v.string(),
		secretAuthTag: v.string(),
		secretEnvelopeVersion: v.number(),
		secretRotatedAt: v.number(),
		createdByUserId: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
		revokedAt: v.optional(v.number()),
	})
		.index('by_organization_id', ['organizationId'])
		.index('by_organization_id_and_plugin_id', ['organizationId', 'pluginId']),

	draftStrategySelections: defineTable({
		organizationId: v.string(),
		scopeType: v.union(v.literal('mailbox'), v.literal('contact'), v.literal('classification')),
		scopeId: v.string(),
		strategyKind: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_organization_scope', ['organizationId', 'scopeType', 'scopeId']),

	pluginStorageEntries: defineTable({
		organizationId: v.string(),
		pluginId: v.string(),
		key: v.string(),
		valueJson: v.string(),
		valueJsonVersion: v.optional(v.number()),
		storedBytes: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_organization_id_and_plugin_id_and_key', ['organizationId', 'pluginId', 'key'])
		.index('by_organization_id_and_plugin_id', ['organizationId', 'pluginId']),

	// AGGREGATED — exact quota counters maintained transactionally by the
	// plugin-storage service on every entry insert, overwrite, and delete.
	pluginStorageUsage: defineTable({
		organizationId: v.string(),
		pluginId: v.string(),
		entryCount: v.number(),
		totalStoredBytes: v.number(),
		updatedAt: v.number(),
	}).index('by_organization_id_and_plugin_id', ['organizationId', 'pluginId']),

	// AGGREGATED — fixed-point micro-USD reservations are serialized through
	// this UTC-day row before a plugin LLM request reaches the provider.
	pluginLlmDailyUsage: defineTable({
		organizationId: v.string(),
		pluginId: v.string(),
		utcDay: v.string(),
		// Budget headroom currently consumed: pending maximums, failed-call
		// maximums, and settled successful charges.
		chargedMicrousd: v.number(),
		actualMicrousd: v.number(),
		admittedCallCount: v.number(),
		updatedAt: v.number(),
	}).index('by_organization_id_and_plugin_id_and_utc_day', [
		'organizationId',
		'pluginId',
		'utcDay',
	]),

	// One host-generated idempotency record per dispatch. Pending/failed rows
	// remain charged; only a known successful completion can release unused
	// reservation headroom safely.
	pluginLlmReservations: defineTable({
		organizationId: v.string(),
		pluginId: v.string(),
		utcDay: v.string(),
		reservationId: v.string(),
		actorUserId: v.string(),
		reservedMicrousd: v.number(),
		tier: v.union(v.literal('fast'), v.literal('capable')),
		modelId: v.string(),
		endpointProvenance: languageEndpointProvenanceValidator,
		chargedMicrousd: v.optional(v.number()),
		actualMicrousd: v.optional(v.number()),
		status: v.union(v.literal('pending'), v.literal('completed'), v.literal('failed')),
		createdAt: v.number(),
		completedAt: v.optional(v.number()),
	})
		.index('by_reservation_id', ['reservationId'])
		.index('by_organization_id_and_plugin_id_and_utc_day', [
			'organizationId',
			'pluginId',
			'utcDay',
		]),

	// Tier-3 sandboxed worker queue (PP-27). One row per enqueued plugin job.
	// The generalized code-worker polls `queued` rows, runs the job as the
	// unprivileged sandbox uid under the confined-root orchestrator, and reports
	// the outcome back. Every row carries `pluginId` + `organizationId` so a job's
	// entire lifecycle is attributable to its owning plugin and tenant (audit).
	pluginTasks: defineTable({
		organizationId: v.string(),
		// Owning plugin. Enqueue rechecks manifest declaration + flag + operator
		// grant of `worker:enqueue` for this id, and that `jobKind` is namespaced to
		// it — a plugin can never enqueue another plugin's job kind.
		pluginId: v.string(),
		// Namespaced routing key `plugin.<pluginId>.<localId>`; the worker maps it to
		// a host-controlled job command. Untrusted only in that a plugin picks which
		// of ITS OWN kinds to run — cross-plugin kinds are rejected at enqueue.
		jobKind: v.string(),
		// Untrusted, plugin-produced job input. Size-clamped at enqueue and passed to
		// the sandboxed child as opaque data (never interpolated into a shell).
		payload: v.string(),
		// Host-clamped wall-clock budget for a single execution; the worker kills the
		// job's whole process group when it is exceeded (fail-closed).
		timeoutMs: v.number(),
		status: v.union(
			v.literal('queued'),
			v.literal('running'),
			v.literal('succeeded'),
			v.literal('failed'),
			v.literal('cancelled')
		),
		// Completed execution attempts. Incremented on claim; retries requeue until
		// `attempts` reaches `maxAttempts`, after which a failure is terminal.
		attempts: v.number(),
		maxAttempts: v.number(),
		// Set by an operator via requestCancel. A queued+cancelled job is marked
		// cancelled at claim time (never runs); a running+cancelled job is killed by
		// the worker's heartbeat check. A cancelled job is never retried.
		isCancelRequested: v.boolean(),
		// Untrusted, size-clamped job result (success) — opaque text for the UI only.
		result: v.optional(v.string()),
		// Clamped, control-stripped failure reason — never a raw provider/system error.
		errorMessage: v.optional(v.string()),
		// Lease bookkeeping: when the worker claimed the job and last proved liveness.
		// A running row whose heartbeat is older than the lease is reclaimed (a
		// crashed worker's job is requeued or failed).
		claimedAt: v.optional(v.number()),
		heartbeatAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// FIFO pickup + lease reclaim both scan by status, oldest first.
		.index('by_status', ['status'])
		// Admin/dashboard reads scope to the tenant.
		.index('by_organization', ['organizationId'])
		// In-flight depth cap: enqueue counts a plugin's `queued` + `running` jobs
		// for the tenant against PLUGIN_WORKER_MAX_PENDING_JOBS without scanning the
		// plugin's terminal (`succeeded`/`failed`/`cancelled`) history.
		.index('by_organization_plugin_status', ['organizationId', 'pluginId', 'status']),
};
