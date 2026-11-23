/**
 * Integration tests for Abuse status (module) + Abuse gate (module).
 *
 * Covers the four-state severity ladder, the internal `transition`
 * severity rules (no lateral moves, no demotes except to clean,
 * banned-terminal), the admin override path, the audit-log effect,
 * and the read-side gate predicates.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { newBetterAuthHarness } from './testModules';
import { _resetSingletonOrgCacheForTests } from '../lib/sessionOrganization';
import { components, internal } from '../_generated/api';
import { isSendingAllowed } from '../workspaces/abuseGate';
import { CAMPAIGN_ALERT_RECEIPT_RETENTION_MS } from '../workspaces/abuseStatus';

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		decrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

afterEach(() => vi.useRealTimers());

/**
 * A status change that stops or resumes sending notifies owners and admins,
 * and that fan-out reads the organization, so the harness has one like any
 * install.
 */
async function harness() {
	_resetSingletonOrgCacheForTests();
	const t = newBetterAuthHarness(modules);
	await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Acme', slug: 'acme', createdAt: 1 } },
	} as never);
	return t;
}
type Tester = Awaited<ReturnType<typeof harness>>;

async function seedSettings(t: Tester, overrides: Record<string, unknown> = {}): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			contactCount: 0,
			createdAt: Date.now(),
			...overrides,
		});
	});
}

// ============================================================
// transition — severity-gated path
// ============================================================

describe('abuseStatus.transition — severity rules', () => {
	it('clean → warned (escalate)', async () => {
		const t = await harness();
		await seedSettings(t);

		const outcome = await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: {
				to: 'warned',
				at: Date.now(),
				reason: 'test',
				changedBy: 'system',
			},
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.from).toBe('clean');
			expect(outcome.to).toBe('warned');
			expect(outcome.applied).toBe('transitioned');
		}

		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			expect(s?.abuseStatus).toBe('warned');
			expect(s?.abuseStatusReason).toBe('test');
			expect(s?.abuseStatusChangedBy).toBe('system');
		});
	});

	it('warned → warned (same-state recorded, audit fires)', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'warned' });

		const outcome = await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: { to: 'warned', at: Date.now(), reason: 'repeat', changedBy: 'mta' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.applied).toBe('recorded');

		// Audit log fires on recorded too — observability captures the attempt.
		await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			expect(logs.some((l) => l.action === 'abuse_status_changed')).toBe(true);
		});
	});

	it('refuses warned → clean as severity_downgrade only when from a stricter state', async () => {
		// Downgrades to `clean` are ALLOWED (auto-recover).
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'warned' });

		const outcome = await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: { to: 'clean', at: Date.now(), reason: 'recover', changedBy: 'system' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.to).toBe('clean');
	});

	it('refuses suspended → warned as severity_downgrade', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended' });

		const outcome = await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: { to: 'warned', at: Date.now(), reason: 'wrong', changedBy: 'system' },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('severity_downgrade');

		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			expect(s?.abuseStatus).toBe('suspended');
		});
	});

	it('banned is terminal for internal writers', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'banned' });

		const outcome = await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: { to: 'clean', at: Date.now(), reason: 'try', changedBy: 'system' },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('terminal');
	});

	it('returns no_settings_row when the singleton is missing', async () => {
		const t = await harness();

		const outcome = await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: { to: 'warned', at: Date.now(), reason: 'x', changedBy: 'system' },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('no_settings_row');
	});
});

describe('abuseStatus.recordCampaignComplaintAlert — transactional idempotency', () => {
	const alert = {
		eventId: `effect:v1:${'a'.repeat(64)}`,
		campaignId: 'jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4',
		message: 'Campaign complaint rate exceeded the threshold',
		complaintRate: 0.004,
		eventTimestamp: 1_700_000_000_000,
	};

	it('commits the status, audit, and 35-day receipt once across response-loss replay', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const t = await harness();
		await seedSettings(t);

		const first = await t.mutation(
			internal.workspaces.abuseStatus.recordCampaignComplaintAlert,
			alert
		);
		const replay = await t.mutation(
			internal.workspaces.abuseStatus.recordCampaignComplaintAlert,
			alert
		);

		expect(first).toEqual({ ok: true, applied: 'transitioned' });
		expect(replay).toEqual({ ok: true, applied: 'duplicate' });
		await t.run(async (ctx) => {
			const receipts = await ctx.db.query('mtaCampaignAlertReceipts').collect();
			const audits = await ctx.db.query('auditLogs').collect();
			expect(receipts).toHaveLength(1);
			expect(receipts[0]).toMatchObject({
				eventId: alert.eventId,
				campaignId: alert.campaignId,
				transitionApplied: 'transitioned',
				expiresAt: Date.now() + CAMPAIGN_ALERT_RECEIPT_RETENTION_MS,
			});
			expect(audits).toHaveLength(1);
			expect(audits[0]?.details?.['eventId']).toBe(alert.eventId);
		});
	});

	it('fails closed when one event id is rebound to different alert content', async () => {
		const t = await harness();
		await seedSettings(t);
		await t.mutation(internal.workspaces.abuseStatus.recordCampaignComplaintAlert, alert);

		expect(
			await t.mutation(internal.workspaces.abuseStatus.recordCampaignComplaintAlert, {
				...alert,
				complaintRate: 0.9,
			})
		).toEqual({ ok: false, reason: 'event_id_conflict' });
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mtaCampaignAlertReceipts').collect()).toHaveLength(1);
			expect(await ctx.db.query('auditLogs').collect()).toHaveLength(1);
		});
	});

	it('does not create a receipt or audit when the settings row is absent', async () => {
		const t = await harness();
		expect(
			await t.mutation(internal.workspaces.abuseStatus.recordCampaignComplaintAlert, alert)
		).toEqual({ ok: false, reason: 'no_settings_row' });
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mtaCampaignAlertReceipts').collect()).toEqual([]);
			expect(await ctx.db.query('auditLogs').collect()).toEqual([]);
		});
	});

	// Reputation auto-enforcement suspends on exactly the complaint rates that
	// raise these alerts, so a refused status change is the CORRELATED case, not
	// a rare one. Retrying can never succeed: record it and acknowledge, or the
	// alert burns its outbox retries and parks in the DLQ forever.
	it.each(['suspended', 'banned'] as const)(
		'records and acknowledges an alert whose status change is refused (%s)',
		async (abuseStatus) => {
			const t = await harness();
			await seedSettings(t, { abuseStatus });

			expect(
				await t.mutation(internal.workspaces.abuseStatus.recordCampaignComplaintAlert, alert)
			).toEqual({ ok: true, applied: 'skipped' });
			await t.run(async (ctx) => {
				const settings = await ctx.db.query('instanceSettings').first();
				expect(settings?.abuseStatus).toBe(abuseStatus);
				expect(await ctx.db.query('mtaCampaignAlertReceipts').collect()).toMatchObject([
					{ eventId: alert.eventId, transitionApplied: 'skipped' },
				]);
				const logs = await ctx.db.query('auditLogs').collect();
				expect(logs).toMatchObject([
					{
						action: 'abuse_status_changed',
						details: {
							previousStatus: abuseStatus,
							newStatus: abuseStatus,
							applied: 'skipped',
							refusedBecause: abuseStatus === 'banned' ? 'terminal' : 'severity_downgrade',
							eventId: alert.eventId,
						},
					},
				]);
			});
		}
	);

	it('replays a refused alert without duplicating its audit row', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended' });

		await t.mutation(internal.workspaces.abuseStatus.recordCampaignComplaintAlert, alert);
		expect(
			await t.mutation(internal.workspaces.abuseStatus.recordCampaignComplaintAlert, alert)
		).toEqual({ ok: true, applied: 'duplicate' });
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mtaCampaignAlertReceipts').collect()).toHaveLength(1);
			expect(await ctx.db.query('auditLogs').collect()).toHaveLength(1);
		});
	});
});

// ============================================================
// adminOverride — bypasses severity rules
// ============================================================

describe('abuseStatus.adminOverride — bypass', () => {
	it('escapes banned by demoting to clean', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'banned' });

		const outcome = await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: {
				to: 'clean',
				at: Date.now(),
				reason: 'appeal accepted',
				changedBy: 'admin-1',
			},
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.from).toBe('banned');
			expect(outcome.to).toBe('clean');
		}

		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			expect(s?.abuseStatus).toBe('clean');
		});
	});

	it('admin can demote suspended → warned (severity rule bypassed)', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended' });

		const outcome = await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'warned', at: Date.now(), reason: 'override', changedBy: 'admin-1' },
		});

		expect(outcome.ok).toBe(true);
		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			expect(s?.abuseStatus).toBe('warned');
		});
	});
});

// ============================================================
// Audit-log effect
// ============================================================

describe('abuseStatus — audit_log effect', () => {
	it('writes an abuse_status_changed audit row on internal transition', async () => {
		const t = await harness();
		await seedSettings(t);

		await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: {
				to: 'suspended',
				at: Date.now(),
				reason: 'Auto-suspended: complaint rate exceeded',
				changedBy: 'system',
			},
		});

		await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			const abuseLog = logs.find((l) => l.action === 'abuse_status_changed');
			expect(abuseLog).toBeDefined();
			expect(abuseLog?.userId).toBe('system');
			expect(abuseLog?.resource).toBe('instance_settings');
			expect(abuseLog?.details?.['previousStatus']).toBe('clean');
			expect(abuseLog?.details?.['newStatus']).toBe('suspended');
			expect(abuseLog?.details?.['adminOverride']).toBe('false');
		});
	});

	it('writes an audit row on admin override', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'banned' });

		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: {
				to: 'clean',
				at: Date.now(),
				reason: 'appeal accepted',
				changedBy: 'admin-1',
			},
		});

		await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			const abuseLog = logs.find((l) => l.action === 'abuse_status_changed');
			expect(abuseLog?.details?.['adminOverride']).toBe('true');
			expect(abuseLog?.details?.['previousStatus']).toBe('banned');
		});
	});

	it('does not write an audit row on illegal_edge / terminal refusals', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'banned' });

		await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: { to: 'clean', at: Date.now(), reason: 'try', changedBy: 'system' },
		});

		await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			expect(logs.some((l) => l.action === 'abuse_status_changed')).toBe(false);
		});
	});
});

// ============================================================
// Suspend and resume: the stored trigger, the audit row, the notice
// ============================================================

describe('abuseStatus — suspend and resume', () => {
	async function noticeKinds(t: Tester): Promise<string[]> {
		return await t.run(async (ctx) => {
			const jobs = await ctx.db.system.query('_scheduled_functions').collect();
			return jobs
				.filter((j) => j.name.includes('fanOut'))
				.map((j) => (j.args[0] as { event: { kind: string } }).event.kind);
		});
	}

	it('the reputation check stores its trigger, audits it and notifies', async () => {
		const t = await harness();
		await seedSettings(t);

		await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: {
				to: 'suspended',
				at: Date.now(),
				reason: 'Auto-suspended: complaint rate or bounce rate exceeded critical thresholds',
				changedBy: 'system',
				trigger: { code: 'complaint_rate' },
			},
		});

		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			expect(s?.abuseStatusTrigger).toEqual({ code: 'complaint_rate' });
			const log = (await ctx.db.query('auditLogs').collect()).find(
				(l) => l.action === 'abuse_status_changed'
			);
			expect(log?.details?.['trigger']).toBe('complaint_rate');
		});
		expect(await noticeKinds(t)).toEqual(['sending_suspended']);
	});

	it('a platform admin suspension stores no trigger, so nothing lifts it automatically', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'warned', abuseStatusTrigger: { code: 'bounce_rate' } });

		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'suspended', at: Date.now(), reason: 'spam', changedBy: 'admin-1' },
		});

		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			expect(s?.abuseStatus).toBe('suspended');
			expect(s?.abuseStatusTrigger).toBeUndefined();
		});
		expect(await noticeKinds(t)).toEqual(['sending_suspended']);
	});

	it('a platform admin who re-imposes an automatic suspension takes it over', async () => {
		const t = await harness();
		await seedSettings(t, {
			abuseStatus: 'suspended',
			abuseStatusChangedBy: 'system',
			abuseStatusTrigger: { code: 'bounce_rate' },
		});

		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'suspended', at: Date.now(), reason: 'keep it off', changedBy: 'admin-1' },
		});

		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			expect(s?.abuseStatusTrigger).toBeUndefined();
			expect(s?.abuseStatusChangedBy).toBe('admin-1');
			expect(s?.abuseStatusReason).toBe('keep it off');
		});
		expect(await noticeKinds(t)).toEqual([]);
	});

	it('a manual lift is audited with its hold and notifies', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
		const t = await harness();
		await seedSettings(t, {
			abuseStatus: 'suspended',
			abuseStatusChangedBy: 'system',
			abuseStatusTrigger: { code: 'bounce_rate' },
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('sendingReputation', {
				scope: 'org',
				periodStart: Date.UTC(2026, 10, 20),
				shardKey: 0,
				totalSent: 1000,
				totalDelivered: 880,
				totalBounced: 120,
				totalHardBounced: 0,
				totalComplaints: 0,
				lastCalculatedAt: Date.now(),
			});
		});

		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'clean', at: Date.now(), reason: 'list cleaned', changedBy: 'admin-1' },
		});

		const holdUntil = Date.UTC(2026, 10, 27, 12);
		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			expect(s?.abuseStatusTrigger).toBeUndefined();
			expect(s?.reputationCheckHold).toEqual({
				until: holdUntil,
				triggers: [{ code: 'bounce_rate' }],
			});
			const log = (await ctx.db.query('auditLogs').collect()).find(
				(l) => l.action === 'abuse_status_changed'
			);
			expect(log?.details?.['holdUntil']).toBe(holdUntil);
		});
		expect(await noticeKinds(t)).toEqual(['sending_resumed']);
	});

	it('a same-state call does not notify again', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended' });

		await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: { to: 'suspended', at: Date.now(), reason: 'again', changedBy: 'system' },
		});

		expect(await noticeKinds(t)).toEqual([]);
	});
});

// ============================================================
// abuseGate — read predicates
// ============================================================

describe('abuseGate.isSendingAllowed', () => {
	it('allows clean / warned / null / undefined', () => {
		expect(isSendingAllowed('clean')).toBe(true);
		expect(isSendingAllowed('warned')).toBe(true);
		expect(isSendingAllowed(null)).toBe(true);
		expect(isSendingAllowed(undefined)).toBe(true);
	});

	it('blocks suspended and banned', () => {
		expect(isSendingAllowed('suspended')).toBe(false);
		expect(isSendingAllowed('banned')).toBe(false);
	});
});

describe('abuseGate.requireSendingAllowed', () => {
	it('returns silently when status is clean', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'clean' });

		// requireSendingAllowed is a runtime-only helper (not a Convex
		// function), so we invoke it through `t.run` against a real
		// MutationCtx. The assertion is "does not throw".
		await expect(
			t.run(async (ctx) => {
				const { requireSendingAllowed } = await import('../workspaces/abuseGate');
				await requireSendingAllowed(ctx);
				return 'ok';
			})
		).resolves.toBe('ok');
	});

	it('returns silently when status is warned (warned is advisory)', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'warned' });

		await expect(
			t.run(async (ctx) => {
				const { requireSendingAllowed } = await import('../workspaces/abuseGate');
				await requireSendingAllowed(ctx);
				return 'ok';
			})
		).resolves.toBe('ok');
	});

	it('throws ConvexError on suspended', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended' });

		await expect(
			t.run(async (ctx) => {
				const { requireSendingAllowed } = await import('../workspaces/abuseGate');
				await requireSendingAllowed(ctx);
			})
		).rejects.toThrow(/suspended/);
	});

	it('throws ConvexError on banned', async () => {
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'banned' });

		await expect(
			t.run(async (ctx) => {
				const { requireSendingAllowed } = await import('../workspaces/abuseGate');
				await requireSendingAllowed(ctx);
			})
		).rejects.toThrow(/permanently disabled/);
	});
});
