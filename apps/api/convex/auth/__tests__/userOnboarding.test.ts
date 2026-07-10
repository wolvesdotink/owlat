/**
 * Per-user onboarding state (auth/userOnboarding).
 *
 * End-to-end over a real (convex-test) datastore:
 *   - the REAL product mutations at each hook point flip their step: connecting
 *     an external account → mailboxReady, migration.start → importStarted,
 *     completeBackfillImport → importDone, finalizeMigration(completed, ran to
 *     completion) → knowledgeIndexed. This pins the wiring (userId + call site),
 *     not just the helper.
 *   - the conditional hook's negative cases: finalizeMigration with status
 *     'failed'/'cancelled', and a 'completed' finalize whose sweep was cut off
 *     by a mid-run feature disable (indexingRanToCompletion:false), all leave
 *     knowledgeIndexed unset.
 *   - markOnboardingStep flips each step from unset → a completion timestamp and
 *     `get` reads them back.
 *   - idempotency: a second mark for the same step preserves the FIRST timestamp.
 *   - isolation: a caller can only read/write their OWN row — asking for or
 *     dismissing another user's id is rejected.
 *   - dismiss round-trips: dismissing sets `dismissedAt`, which `get` reflects.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { markOnboardingStep, type OnboardingStep } from '../userOnboarding';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'admin' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
		// Self-gate: mirror production's requireSelf — accept the caller's own id,
		// reject anyone else's. Lets the isolation test exercise the real guard.
		requireSelf: vi.fn(async (_ctx: unknown, claimed: string) => {
			if (claimed !== sessionMocks.userId) {
				throw new Error('forbidden: not self');
			}
			return claimed;
		}),
	};
});

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
			([path]) =>
				!path.includes('sesActions') &&
				!path.includes('agent/walker') &&
				!path.includes('agent/steps/index') &&
				!path.includes('agent/steps/classify') &&
				!path.includes('agent/steps/draft') &&
				!path.includes('agent/steps/clarify') &&
				!path.includes('knowledgeExtraction') &&
				!path.includes('semanticFileProcessing') &&
				!path.includes('visualizationAgent') &&
				!path.includes('llmProvider')
		)
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../auth/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

const HOOK_STEPS: OnboardingStep[] = [
	'mailboxReady',
	'importStarted',
	'importDone',
	'knowledgeIndexed',
];

/** IMAP/SMTP credentials for `_connectInternal` (ciphertext bytes are dummy). */
const CREDS = {
	emailAddress: 'me@example.com',
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.example.com',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'me@example.com',
	authMethod: 'password' as const,
	secretCiphertext: 'ZmFrZS1jaXBoZXI=',
	secretIv: 'ZmFrZS1pdg==',
	secretAuthTag: 'ZmFrZS10YWc=',
	secretEnvelopeVersion: 1,
};

async function enableFlags(
	t: ReturnType<typeof convexTest>,
	flags: Record<string, boolean>
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', { featureFlags: flags, createdAt: Date.now() });
	});
}

describe('userOnboarding — real hook wiring', () => {
	it('connecting an external account marks mailboxReady for the connecting user', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		sessionMocks.userId = 'user-A';

		await t.mutation(internal.mail.externalAccounts._connectInternal, CREDS);

		const state = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(typeof state.mailboxReady).toBe('number');
	});

	it('start → importStarted, completeBackfillImport → importDone, finalize(completed) → knowledgeIndexed', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true, ai: true, 'ai.knowledge': true });
		sessionMocks.userId = 'user-A';

		await t.mutation(internal.mail.externalAccounts._connectInternal, CREDS);

		const { migrationId } = await t.mutation(api.mail.migration.start, {});
		let state = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(typeof state.importStarted).toBe('number');
		expect(state.importDone).toBeNull();
		expect(state.knowledgeIndexed).toBeNull();

		// Import done → hands off to the indexing phase (ai.knowledge is on).
		await t.mutation(internal.mail.migration.completeBackfillImport, { migrationId });
		state = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(typeof state.importDone).toBe('number');
		// Still indexing — knowledge is not indexed until the sweep finalizes.
		expect(state.knowledgeIndexed).toBeNull();

		// A sweep that ran to its natural end marks the step.
		await t.mutation(internal.mail.migrationIndexing.finalizeMigration, {
			migrationId,
			status: 'completed',
			indexingRanToCompletion: true,
		});
		state = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(typeof state.knowledgeIndexed).toBe('number');
	});

	it('finalize(completed) with a cut-off sweep leaves knowledgeIndexed unset', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true, ai: true, 'ai.knowledge': true });
		sessionMocks.userId = 'user-A';

		await t.mutation(internal.mail.externalAccounts._connectInternal, CREDS);
		const { migrationId } = await t.mutation(api.mail.migration.start, {});
		await t.mutation(internal.mail.migration.completeBackfillImport, { migrationId });

		// The feature-disable branch finalizes 'completed' but ran-to-completion is
		// false — the knowledge sweep was cut off, so the step must NOT be marked.
		await t.mutation(internal.mail.migrationIndexing.finalizeMigration, {
			migrationId,
			status: 'completed',
			indexingRanToCompletion: false,
		});

		const state = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(state.knowledgeIndexed).toBeNull();
	});

	it.each(['failed', 'cancelled'] as const)(
		'finalize(%s) leaves knowledgeIndexed unset',
		async (status) => {
			const t = convexTest(schema, modules);
			await enableFlags(t, { 'mail.external': true, ai: true, 'ai.knowledge': true });
			sessionMocks.userId = 'user-A';

			await t.mutation(internal.mail.externalAccounts._connectInternal, CREDS);
			const { migrationId } = await t.mutation(api.mail.migration.start, {});
			await t.mutation(internal.mail.migration.completeBackfillImport, { migrationId });

			await t.mutation(internal.mail.migrationIndexing.finalizeMigration, {
				migrationId,
				status,
				errorMessage: 'stopped',
			});

			const state = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
			expect(state.knowledgeIndexed).toBeNull();
		}
	);
});

describe('userOnboarding', () => {
	it('flips each hook step from unset to a timestamp and reads it back', async () => {
		const t = convexTest(schema, modules);

		// Nothing done yet → a concrete all-null state (no row required).
		const before = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		for (const step of HOOK_STEPS) {
			expect(before[step]).toBeNull();
		}
		expect(before.dismissedAt).toBeNull();

		for (const step of HOOK_STEPS) {
			await t.run(async (ctx) => {
				await markOnboardingStep(ctx, 'user-A', step);
			});
		}

		const after = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		for (const step of HOOK_STEPS) {
			expect(typeof after[step]).toBe('number');
		}
	});

	it('preserves the first-completion timestamp when a step is marked twice', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await markOnboardingStep(ctx, 'user-A', 'mailboxReady');
		});
		const first = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		const firstTs = first.mailboxReady;
		expect(typeof firstTs).toBe('number');

		// A later replay of the same flow must not move the timestamp.
		await t.run(async (ctx) => {
			await markOnboardingStep(ctx, 'user-A', 'mailboxReady');
		});
		const second = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(second.mailboxReady).toBe(firstTs);
	});

	it("does not leak another user's onboarding state", async () => {
		const t = convexTest(schema, modules);

		// user-B has progress; user-A (the session) must not be able to read it.
		await t.run(async (ctx) => {
			await markOnboardingStep(ctx, 'user-B', 'firstSendDone');
		});

		sessionMocks.userId = 'user-A';
		await expect(t.query(api.auth.userOnboarding.get, { userId: 'user-B' })).rejects.toThrow();
	});

	it("rejects dismissing another user's onboarding state", async () => {
		const t = convexTest(schema, modules);

		// The write path is self-gated too: user-A cannot dismiss user-B's checklist.
		sessionMocks.userId = 'user-A';
		await expect(
			t.mutation(api.auth.userOnboarding.dismiss, { userId: 'user-B' })
		).rejects.toThrow();
	});

	it('round-trips a dismissal', async () => {
		const t = convexTest(schema, modules);

		sessionMocks.userId = 'user-A';
		const before = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(before.dismissedAt).toBeNull();

		await t.mutation(api.auth.userOnboarding.dismiss, { userId: 'user-A' });

		const after = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(typeof after.dismissedAt).toBe('number');
	});
});
