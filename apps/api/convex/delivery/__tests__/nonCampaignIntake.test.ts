/**
 * `delivery/nonCampaignIntake` — the ONE intake for automation email steps and
 * agent approved-replies, and the typed outcome union both producers consume.
 *
 * ── The gate sequence (PIECE C2) ────────────────────────────────────────────
 *
 * The intake runs the shared pre-row gates from `delivery/sendIntakeGates.ts`
 * in one fixed order — abuse → provider-ready → suppression — and REPORTS each
 * refusal as `{ ok: false, reason }`. Pre-C2 the same module threw
 * `Error('recipient_blocked')` / `Error('no_delivery_provider')` from exported
 * magic-string constants, had no abuse gate at all, and let its two callers
 * re-classify the refusal by string-matching the message.
 *
 * Coverage here:
 *   - one test per rejection reason: no row, no assignment row, no enqueue;
 *   - the gate ORDER, pinned by a case where two gates would both refuse;
 *   - the positive control: `{ ok: true, queued: true }` + a `queued` row.
 *
 * ── Route resolution moved INTO the intake (PIECE C2) ───────────────────────
 *
 * Both producers used to resolve an advisory route in their own action and
 * hand `providerType`/`ipPool` down. The intake owns that resolution now, in
 * the same transaction as the insert, so the row and the envelope are stamped
 * from the resolution the provider gate actually judged.
 *
 * ── What the intake puts ON THE DURABLE ENVELOPE (G-02 / CL-01) ─────────────
 *
 * The non-campaign half of the engagement-score threading (one indexed point
 * read in the enqueue transaction) and the RFC 3834 `Auto-Submitted` stamping
 * that distinguishes a 1:1 agent reply from an automation broadcast.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	createTestBlockedEmail,
	createTestContact,
	createTestInstanceSettings,
} from '../../__tests__/factories';

// Stub the workpool so the intake's `enqueueAction` is a no-op (the Workpool
// component isn't registered in convexTest, and the worker action would need
// provider credentials we don't seed). We assert pre-dispatch DB state.
vi.mock('../workpool', () => ({
	transactionalEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
	campaignEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
}));

// Vite's `import.meta.glob` excludes the directory chain it climbed up through
// to reach the glob base, so `'../../**'` from this `delivery/__tests__` file
// omits the sibling `delivery/*` modules (including the unit under test). Merge
// a second glob rooted at `delivery/` (`'../**'`) to recover them, re-prefixing
// its keys to the same `../../`-relative form so convex-test's single
// module-root prefix resolves every entry.
const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		mod,
	])
);
const allModules = { ...rootGlob, ...deliveryGlob };
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool')
	)
);

// Silence "Could not find module" rejections from the excluded workpool/worker
// modules — the intake schedules an action whose target module is filtered out
// of this harness. The intake itself completes; the scheduled task can't find
// its target.
const suppressed: Error[] = [];
const onRejection = (err: Error) => {
	if (
		err.message?.includes('Could not find module') ||
		err.message?.includes('Write outside of transaction')
	) {
		suppressed.push(err);
	} else {
		throw err;
	}
};
beforeEach(() => {
	suppressed.length = 0;
	process.on('unhandledRejection', onRejection);
});
afterEach(() => {
	process.removeListener('unhandledRejection', onRejection);
});

async function enqueueAutomation(t: TestConvex<typeof schema>, email: string) {
	return await t.mutation(internal.delivery.nonCampaignIntake.intake, {
		kind: 'automation' as const,
		email,
		subject: 'Hi',
		html: '<p>Hi</p>',
		from: 'Owlat <noreply@example.com>',
	});
}

/** No row, no experiment record, no workpool job — the pre-row refusal claim. */
async function expectNothingWritten(t: TestConvex<typeof schema>): Promise<void> {
	await t.run(async (ctx) => {
		expect(await ctx.db.query('transactionalSends').collect()).toHaveLength(0);
		expect(await ctx.db.query('sendAssignments').collect()).toHaveLength(0);
	});
}

function withNoDeliveryProvider(run: () => Promise<void>): Promise<void> {
	vi.stubEnv('EMAIL_PROVIDER', '');
	vi.stubEnv('MTA_API_URL', '');
	vi.stubEnv('MTA_API_KEY', '');
	return run().finally(() => vi.unstubAllEnvs());
}

// ─── One test per rejection reason ───────────────────────────────────────────

describe('delivery.nonCampaignIntake.intake — typed rejections', () => {
	it('returns recipient_blocked and writes nothing when the recipient is suppressed', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com', reason: 'complained' })
			);
		});

		const outcome = await enqueueAutomation(t, 'blocked@example.com');

		expect(outcome).toEqual({ ok: false, reason: 'recipient_blocked' });
		await expectNothingWritten(t);
	});

	it('normalizes the lookup so a mixed-case recipient is still blocked', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com', reason: 'bounced' })
			);
		});

		const outcome = await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: 'agent_reply' as const,
			email: '  Blocked@Example.com  ',
			subject: 'Re: Hi',
			html: '<p>Re: Hi</p>',
			from: 'Owlat <noreply@example.com>',
		});

		expect(outcome).toEqual({ ok: false, reason: 'recipient_blocked' });
		await expectNothingWritten(t);
	});

	it('returns no_delivery_provider (with operator detail) when nothing can deliver', async () => {
		const t = convexTest(schema, modules);
		await withNoDeliveryProvider(async () => {
			const outcome = await enqueueAutomation(t, 'allowed@example.com');

			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			expect(outcome.reason).toBe('no_delivery_provider');
			expect(outcome.detail).toMatch(/EMAIL_PROVIDER/);
			await expectNothingWritten(t);
		});
	});

	it('returns abuse_blocked when the instance is suspended', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'instanceSettings',
				createTestInstanceSettings({ abuseStatus: 'suspended' })
			);
		});

		const outcome = await enqueueAutomation(t, 'allowed@example.com');

		expect(outcome).toEqual({ ok: false, reason: 'abuse_blocked' });
		await expectNothingWritten(t);
	});

	it('returns abuse_blocked for a banned instance too', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'instanceSettings',
				createTestInstanceSettings({ abuseStatus: 'banned' })
			);
		});

		expect(await enqueueAutomation(t, 'allowed@example.com')).toEqual({
			ok: false,
			reason: 'abuse_blocked',
		});
	});

	// THE ORDER IS THE CONTRACT, not an accident of where the checks sit: the
	// broadest refusal must answer first, so a suspended instance reports
	// `abuse_blocked` even when the recipient would ALSO have been refused.
	// Reporting `recipient_blocked` here would send the operator hunting through
	// the blocklist for a deployment-level suspension.
	it('reports the BROADEST refusal first when several gates would refuse', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'instanceSettings',
				createTestInstanceSettings({ abuseStatus: 'suspended' })
			);
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com', reason: 'complained' })
			);
		});

		expect(await enqueueAutomation(t, 'blocked@example.com')).toEqual({
			ok: false,
			reason: 'abuse_blocked',
		});
	});

	it('reports no_delivery_provider before recipient_blocked', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com', reason: 'complained' })
			);
		});

		await withNoDeliveryProvider(async () => {
			const outcome = await enqueueAutomation(t, 'blocked@example.com');
			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			expect(outcome.reason).toBe('no_delivery_provider');
		});
	});

	// THE SCOPE IS PER-KIND. An `unengaged` marketing-hygiene row blocks the
	// automation kind and must NOT block a 1:1 answer to a human who wrote in.
	it('gates the automation kind at the marketing scope and the reply at the transactional one', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'quiet@example.com',
				reason: 'unengaged' as const,
				createdAt: Date.now(),
			});
		});

		expect(await enqueueAutomation(t, 'quiet@example.com')).toEqual({
			ok: false,
			reason: 'recipient_blocked',
		});

		const reply = await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: 'agent_reply' as const,
			email: 'quiet@example.com',
			subject: 'Re: Hi',
			html: '<p>Re: Hi</p>',
			from: 'Owlat <support@example.com>',
		});
		expect(reply.ok).toBe(true);
	});

	it('returns ok with a queued row for a non-blocked recipient (positive control)', async () => {
		const t = convexTest(schema, modules);

		const outcome = await enqueueAutomation(t, 'allowed@example.com');

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.queued).toBe(true);
		const send = await t.run(async (ctx) => ctx.db.get(outcome.sendId));
		expect(send?.status).toBe('queued');
		expect(send?.kind).toBe('automation');
		expect(send?.email).toBe('allowed@example.com');
	});
});

// ─── Route resolution is the intake's own (PIECE C2) ─────────────────────────

describe('delivery.nonCampaignIntake.intake — route resolution', () => {
	it('stamps the row and envelope from the route it resolved itself, with no caller-supplied provider', async () => {
		const t = convexTest(schema, modules);
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();

		const outcome = await enqueueAutomation(t, 'routed@example.com');

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// `EMAIL_PROVIDER=mta` in vitest.setup.ts, no `providerRoutes` row → the
		// env fallback. The producers no longer pass a `providerType` argument at
		// all, so this value can only have come from the intake's own resolution.
		const send = await t.run(async (ctx) => ctx.db.get(outcome.sendId));
		expect(send?.providerType).toBe('mta');
		const envelopeInput = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(envelopeInput?.['providerType']).toBe('mta');
	});

	it('resolves the automation kind against the automation route table', async () => {
		const t = convexTest(schema, modules);
		// Only the `automation` table names the relay; a resolution against the
		// wrong message type would fall through to the `mta` env default.
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'automation' as const,
				strategy: 'single' as const,
				providers: [{ providerType: 'resend', isEnabled: true }],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		vi.stubEnv('RESEND_API_KEY', 'test-resend-key');
		try {
			const outcome = await enqueueAutomation(t, 'routed@example.com');
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			const send = await t.run(async (ctx) => ctx.db.get(outcome.sendId));
			expect(send?.providerType).toBe('resend');
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

// ─── CL-01: the agent 1:1 reply collapses onto the transactional envelope ────

describe('delivery.nonCampaignIntake.intake — Auto-Submitted stamping', () => {
	it('threads autoSubmittedType: auto-replied (and no List-Unsubscribe) on the agent_reply envelope', async () => {
		const t = convexTest(schema, modules);
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();

		await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: 'agent_reply' as const,
			email: 'customer@example.com',
			subject: 'Re: your message',
			html: '<p>Thanks for reaching out.</p>',
			from: 'Owlat <support@example.com>',
		});

		expect(enqueueAction).toHaveBeenCalledTimes(1);
		const envelopeInput = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(envelopeInput?.['kind']).toBe('transactional');
		expect(envelopeInput?.['emailPurpose']).toBe('transactional');
		expect(envelopeInput?.['messageType']).toBe('transactional');
		expect(envelopeInput?.['autoSubmittedType']).toBe('auto-replied');
		expect(envelopeInput?.['listUnsubscribe']).toBeUndefined();
	});

	it('does NOT set autoSubmittedType on the automation envelope (composer defaults to auto-generated)', async () => {
		const t = convexTest(schema, modules);
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();

		await enqueueAutomation(t, 'allowed@example.com');

		expect(enqueueAction).toHaveBeenCalledTimes(1);
		const envelopeInput = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(envelopeInput?.['kind']).toBe('transactional');
		expect(envelopeInput?.['emailPurpose']).toBe('marketing');
		expect(envelopeInput?.['messageType']).toBe('automation');
		expect(envelopeInput?.['autoSubmittedType']).toBeUndefined();
	});
});

// ─── G-02: the engagement score is put ON THE ENVELOPE by the intake ─────────
//
// The score is read with ONE indexed point read in the enqueue transaction —
// never per-recipient inside the dispatch action. An unscored contact, and a
// send with no contact at all, OMIT the field: `0` is the "cold" band and would
// be a different, wrong claim.

describe('delivery.nonCampaignIntake.intake — engagementScore on the send envelope', () => {
	async function envelopeFor(
		t: TestConvex<typeof schema>,
		args: {
			email: string;
			contactId?: Id<'contacts'>;
			kind?: 'automation' | 'agent_reply';
		}
	): Promise<Record<string, unknown> | undefined> {
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();
		await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: args.kind ?? ('automation' as const),
			email: args.email,
			...(args.contactId ? { contactId: args.contactId } : {}),
			subject: 'Hi',
			html: '<p>Hi</p>',
			from: 'Owlat <noreply@example.com>',
		});
		return enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
	}

	it('puts the contact score on the automation envelope', async () => {
		const t = convexTest(schema, modules);
		const contactId = await t.run(
			async (ctx) =>
				await ctx.db.insert(
					'contacts',
					createTestContact({ email: 'scored@example.com', engagementScore: 64 })
				)
		);

		const envelopeInput = await envelopeFor(t, { email: 'scored@example.com', contactId });
		expect(envelopeInput?.['engagementScore']).toBe(64);
	});

	it('omits the field for an unscored contact', async () => {
		const t = convexTest(schema, modules);
		const contactId = await t.run(
			async (ctx) =>
				await ctx.db.insert('contacts', createTestContact({ email: 'unscored@example.com' }))
		);

		const envelopeInput = await envelopeFor(t, { email: 'unscored@example.com', contactId });
		expect(envelopeInput).toBeDefined();
		expect('engagementScore' in envelopeInput!).toBe(false);
	});

	it('does not look up a contact — and carries no score — when the send has none', async () => {
		const t = convexTest(schema, modules);
		// A scored contact exists for the SAME address; with no contactId on the
		// send there is no lookup, so the score must not leak onto the envelope.
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'orphan@example.com', engagementScore: 91 })
			);
		});

		const envelopeInput = await envelopeFor(t, {
			email: 'orphan@example.com',
			kind: 'agent_reply',
		});
		expect(envelopeInput).toBeDefined();
		expect('engagementScore' in envelopeInput!).toBe(false);
	});

	// ── Adversarial: normalise at the WRITE boundary, not only on read ────────
	//
	// A degenerate stored score (an upstream scorer defect) must never enter the
	// DURABLE envelope. It would be persisted into `routingReentry.envelopeInput`,
	// handed to the MTA, and echoed back through the re-entry webhook — where a
	// NaN returns as `null`, `envelopeInputValidator` (`v.optional(v.number())`)
	// rejects it, and the deferred send's callback is silently dropped.
	it('drops a degenerate STORED score at the write boundary', async () => {
		const t = convexTest(schema, modules);
		const contactId = await t.run(
			async (ctx) =>
				await ctx.db.insert(
					'contacts',
					createTestContact({ email: 'degenerate@example.com', engagementScore: -1 })
				)
		);

		const envelopeInput = await envelopeFor(t, { email: 'degenerate@example.com', contactId });
		expect(envelopeInput).toBeDefined();
		// Unknown, NOT clamped to 0 — clamping would invent the "cold" band for a
		// value that carries no information.
		expect('engagementScore' in envelopeInput!).toBe(false);
	});
});
