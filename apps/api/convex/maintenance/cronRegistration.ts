import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

/** Daily retention jobs, grouped with their maintenance handlers. */
export function registerRetentionCrons(crons: ReturnType<typeof cronJobs>): void {
	// PII retention sweeps (see maintenance/retention.ts): audit trails age out
	// after 30 days, form-submission IP/UA after 90, agent-health rollup points
	// after 7; auth-failure rows after their TTL (the mailAuthFailures schema
	// always claimed this cron — now it actually exists).
	crons.interval(
		'retention: audit logs',
		{ hours: 24 },
		internal.maintenance.retention.sweepAuditLogs,
		{}
	);
	crons.interval(
		'retention: mail audit log',
		{ hours: 24 },
		internal.maintenance.retention.sweepMailAuditLog,
		{}
	);
	crons.interval(
		'retention: plugin llm accounting',
		{ hours: 24 },
		internal.maintenance.retention.sweepPluginLlmAccounting,
		{}
	);
	crons.interval(
		'retention: agent metrics',
		{ hours: 24 },
		internal.maintenance.retention.sweepAgentMetrics,
		{}
	);
	crons.interval(
		'retention: form submission metadata',
		{ hours: 24 },
		internal.maintenance.retention.scrubFormSubmissionMeta,
		{}
	);
	// Inbound mail FILES (see maintenance/retention.ts): the sealed raw `.eml` and
	// the team-inbox attachment blobs captured out of it are released past the
	// horizon set in Settings (`DEFAULT_INBOUND_RAW_RETENTION_DAYS` when unset).
	// Bytes only — every row and all of its metadata stays. ONE entry for one
	// horizon: the two walks are the same decision from the same setting. Daily,
	// because the horizon is measured in days, so a tick stays small.
	crons.interval(
		'retention: inbound mail files',
		{ hours: 24 },
		internal.maintenance.retention.sweepInboundFiles,
		{}
	);
}
