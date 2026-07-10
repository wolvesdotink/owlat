/**
 * Integration tests for Abuse status (module) + Abuse gate (module).
 *
 * Covers the four-state severity ladder, the internal `transition`
 * severity rules (no lateral moves, no demotes except to clean,
 * banned-terminal), the admin override path, the audit-log effect,
 * and the read-side gate predicates.
 *
 * See docs/adr/0011-abuse-status-modules.md.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { isSendingAllowed } from '../workspaces/abuseGate';

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
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

async function seedSettings(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {}
): Promise<void> {
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
		const t = convexTest(schema, modules);
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
		const t = convexTest(schema, modules);
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
		// Per ADR-0011: downgrades to `clean` are ALLOWED (auto-recover).
		const t = convexTest(schema, modules);
		await seedSettings(t, { abuseStatus: 'warned' });

		const outcome = await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: { to: 'clean', at: Date.now(), reason: 'recover', changedBy: 'system' },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.to).toBe('clean');
	});

	it('refuses suspended → warned as severity_downgrade', async () => {
		const t = convexTest(schema, modules);
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
		const t = convexTest(schema, modules);
		await seedSettings(t, { abuseStatus: 'banned' });

		const outcome = await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: { to: 'clean', at: Date.now(), reason: 'try', changedBy: 'system' },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('terminal');
	});

	it('returns no_settings_row when the singleton is missing', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: { to: 'warned', at: Date.now(), reason: 'x', changedBy: 'system' },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('no_settings_row');
	});
});

// ============================================================
// adminOverride — bypasses severity rules
// ============================================================

describe('abuseStatus.adminOverride — bypass', () => {
	it('escapes banned by demoting to clean', async () => {
		const t = convexTest(schema, modules);
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
		const t = convexTest(schema, modules);
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
// Audit-log effect (ADR-0011 drift fix #5)
// ============================================================

describe('abuseStatus — audit_log effect', () => {
	it('writes an abuse_status_changed audit row on internal transition', async () => {
		const t = convexTest(schema, modules);
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
		const t = convexTest(schema, modules);
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
		const t = convexTest(schema, modules);
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
		const t = convexTest(schema, modules);
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
		const t = convexTest(schema, modules);
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
		const t = convexTest(schema, modules);
		await seedSettings(t, { abuseStatus: 'suspended' });

		await expect(
			t.run(async (ctx) => {
				const { requireSendingAllowed } = await import('../workspaces/abuseGate');
				await requireSendingAllowed(ctx);
			})
		).rejects.toThrow(/suspended/);
	});

	it('throws ConvexError on banned', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t, { abuseStatus: 'banned' });

		await expect(
			t.run(async (ctx) => {
				const { requireSendingAllowed } = await import('../workspaces/abuseGate');
				await requireSendingAllowed(ctx);
			})
		).rejects.toThrow(/permanently disabled/);
	});
});
