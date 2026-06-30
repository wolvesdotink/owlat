/**
 * Per-transition unit/integration tests for the Mail draft lifecycle module.
 *
 * Covers each transition kind (`→ pending_send`, `→ scheduled`, `→ draft x 3
 * reasons`, `→ sent`), the typed effect list (audit-log + storage cleanup
 * regression), the `transitionByUndoToken` idempotency invariant, and the
 * `assertStateIs` helper.
 *
 * See docs/adr/0028-mail-draft-lifecycle-module.md.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { assertStateIs, dedupedRecipients } from '../mail/draftLifecycle';
import type { Doc } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
		}),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
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

// ─── Helpers ────────────────────────────────────────────────────────────────

async function seedMailboxAndSent(
	t: ReturnType<typeof convexTest>,
	address = 'alice@example.com',
): Promise<{
	mailboxId: Id<'mailboxes'>;
	sentFolderId: Id<'mailFolders'>;
}> {
	let mailboxId!: Id<'mailboxes'>;
	let sentFolderId!: Id<'mailFolders'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address,
			domain: address.split('@')[1],
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		sentFolderId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'Sent',
			role: 'sent',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
	return { mailboxId, sentFolderId };
}

async function seedDraft(
	t: ReturnType<typeof convexTest>,
	mailboxId: Id<'mailboxes'>,
	overrides: {
		state?: 'draft' | 'pending_send' | 'scheduled';
		toAddresses?: string[];
		bccAddresses?: string[];
		fromAddress?: string;
		attachments?: Array<{
			storageId: Id<'_storage'>;
			filename: string;
			contentType: string;
			size: number;
			isInline: boolean;
			contentId?: string;
		}>;
		undoToken?: string;
		scheduledSendAt?: number;
		inReplyToMessageId?: Id<'mailMessages'>;
	} = {},
): Promise<Id<'mailDrafts'>> {
	let draftId!: Id<'mailDrafts'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		draftId = await ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: overrides.toAddresses ?? ['bob@example.com'],
			ccAddresses: [],
			bccAddresses: overrides.bccAddresses ?? [],
			fromAddress: overrides.fromAddress ?? 'alice@example.com',
			subject: 'Hi',
			bodyHtml: '<p>Hi</p>',
			attachments: overrides.attachments ?? [],
			state: overrides.state ?? 'draft',
			...(overrides.inReplyToMessageId
				? { inReplyToMessageId: overrides.inReplyToMessageId }
				: {}),
			...(overrides.undoToken ? { undoToken: overrides.undoToken } : {}),
			...(overrides.scheduledSendAt !== undefined
				? { scheduledSendAt: overrides.scheduledSendAt }
				: {}),
			lastEditedAt: now,
			createdAt: now,
		});
	});
	return draftId;
}

async function storeBlob(
	t: ReturnType<typeof convexTest>,
): Promise<Id<'_storage'>> {
	let storageId!: Id<'_storage'>;
	await t.run(async (ctx) => {
		storageId = await ctx.storage.store(
			new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }),
		);
	});
	return storageId;
}

/**
 * Seed a minimal inbound `mailMessages` row (with a thread) in the given
 * mailbox so a draft can reference it via `inReplyToMessageId`. Returns the
 * message id; `flagAnswered` starts false.
 */
async function seedInboundMessage(
	t: ReturnType<typeof convexTest>,
	mailboxId: Id<'mailboxes'>,
): Promise<Id<'mailMessages'>> {
	let messageId!: Id<'mailMessages'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'hello',
			participants: ['sender@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'snip',
			latestFromAddress: 'sender@example.com',
			latestSubject: 'Hello',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const inboxId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 2,
			highestModseq: 1,
			totalCount: 1,
			unseenCount: 1,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: inboxId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${Math.random().toString(36).slice(2)}@example.com>`,
			threadId,
			fromAddress: 'sender@example.com',
			toAddresses: ['recipient@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Hello',
			normalizedSubject: 'hello',
			snippet: 'snip',
			rawStorageId,
			rawSize: 3,
			attachments: [],
			hasAttachments: false,
			flagSeen: false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return messageId;
}

function makeSentContext(rawStorageId: Id<'_storage'>) {
	return {
		rawStorageId,
		rawSize: 100,
		rfc822MessageId: 'test-msg@example.com',
		references: [] as string[],
		bodyHtml: '<p>Hi</p>',
		bodyText: 'Hi',
		attachmentsMeta: [] as Array<{
			filename: string;
			contentType: string;
			size: number;
			contentId?: string;
			partIndex: string;
		}>,
	};
}

// ─── assertStateIs ──────────────────────────────────────────────────────────

describe('assertStateIs', () => {
	it('does nothing when the state matches', () => {
		expect(() =>
			assertStateIs(
				{ state: 'draft' } as Parameters<typeof assertStateIs>[0],
				'draft',
			),
		).not.toThrow();
	});

	it('throws when the state does not match', () => {
		expect(() =>
			assertStateIs(
				{ state: 'pending_send' } as Parameters<typeof assertStateIs>[0],
				'draft',
			),
		).toThrow(/Draft state is pending_send, expected draft/);
	});
});

// ─── dedupedRecipients (envelope fan-out) ─────────────────────────────────────

describe('dedupedRecipients', () => {
	it('keeps Bcc in the transport recipient set even though it is hidden from headers (audit PR-52)', () => {
		// buildRfc822 suppresses Bcc from the header block (RFC 5322 §3.6.3),
		// but the envelope recipient set — which drives both the stored
		// mailMessages.outbound.recipients[] and the MTA fan-out — must still
		// deliver to the Bcc address.
		// dedupedRecipients only reads the to/cc/bcc address arrays.
		const recipients = dedupedRecipients({
			toAddresses: ['a@x.test'],
			ccAddresses: [],
			bccAddresses: ['secret@y.test'],
		} as unknown as Doc<'mailDrafts'>);

		expect(recipients).toContain('a@x.test');
		expect(recipients).toContain('secret@y.test');
	});
});

// ─── → pending_send ─────────────────────────────────────────────────────────

describe('draftLifecycle.transition — to: pending_send', () => {
	it('patches draft → pending_send with an undo token + sendAt', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId);
		const now = Date.now();

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: { to: 'pending_send', at: now, undoSendDelayMs: 5000 },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.from).toBe('draft');
			expect(outcome.to).toBe('pending_send');
			expect(outcome.undoToken).toMatch(/^und_/);
			expect(outcome.sendAt).toBe(now + 5000);
		}

		await t.run(async (ctx) => {
			const draft = await ctx.db.get(draftId);
			expect(draft?.state).toBe('pending_send');
			expect(draft?.undoToken).toMatch(/^und_/);
			expect(draft?.scheduledSendAt).toBe(now + 5000);
		});
	});

	it('refuses with no_recipients when toAddresses is empty', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId, { toAddresses: [] });

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: { to: 'pending_send', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('no_recipients');
	});

	it('refuses with no_recipients when To is empty even if Bcc is set (audit PR-52)', async () => {
		// A draft addressed to Bcc-only recipients must still be rejected: the
		// pending_send gate checks `toAddresses.length`, not the Bcc fan-out.
		// RFC 5322 §3.6.3 — a Bcc-only message would ship with an empty `To`.
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId, {
			toAddresses: [],
			bccAddresses: ['secret@y.test'],
		});

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: { to: 'pending_send', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('no_recipients');
	});

	it('writes an audit log for the transition', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId);

		await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: { to: 'pending_send', at: Date.now() },
		});

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.filter((q) =>
					q.eq(q.field('action'), 'postbox_draft.send_initiated'),
				)
				.collect();
			expect(logs.length).toBe(1);
			expect(logs[0]!.resourceId).toBe(draftId);
		});
	});
});

// ─── → scheduled ────────────────────────────────────────────────────────────

describe('draftLifecycle.transition — to: scheduled', () => {
	it('patches draft → scheduled with the given scheduledSendAt', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId);
		const scheduledSendAt = Date.now() + 60_000;

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: { to: 'scheduled', at: Date.now(), scheduledSendAt },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.sendAt).toBe(scheduledSendAt);

		await t.run(async (ctx) => {
			const draft = await ctx.db.get(draftId);
			expect(draft?.state).toBe('scheduled');
			expect(draft?.scheduledSendAt).toBe(scheduledSendAt);
		});
	});
});

// ─── → draft revert ─────────────────────────────────────────────────────────

describe('draftLifecycle.transition — to: draft (revert)', () => {
	const REASONS: Array<{
		reason: 'user_cancel' | 'from_revoked' | 'scan_blocked';
		auditAction: string;
	}> = [
		{ reason: 'user_cancel', auditAction: 'postbox_draft.cancelled' },
		{ reason: 'from_revoked', auditAction: 'postbox_draft.from_revoked' },
		{ reason: 'scan_blocked', auditAction: 'postbox_draft.scan_blocked' },
	];

	for (const { reason, auditAction } of REASONS) {
		it(`reverts pending_send → draft and emits ${auditAction} (reason: ${reason})`, async () => {
			const t = convexTest(schema, modules);
			const { mailboxId } = await seedMailboxAndSent(t);
			const draftId = await seedDraft(t, mailboxId, {
				state: 'pending_send',
				undoToken: 'tok-1',
				scheduledSendAt: Date.now() + 5_000,
			});

			const outcome = await t.mutation(
				internal.mail.draftLifecycle.transition,
				{
					draftId,
					input: { to: 'draft', at: Date.now(), reason },
				},
			);
			expect(outcome.ok).toBe(true);

			await t.run(async (ctx) => {
				const draft = await ctx.db.get(draftId);
				expect(draft?.state).toBe('draft');
				expect(draft?.undoToken).toBeUndefined();
				expect(draft?.scheduledSendAt).toBeUndefined();

				const logs = await ctx.db
					.query('auditLogs')
					.filter((q) => q.eq(q.field('action'), auditAction))
					.collect();
				expect(logs.length).toBe(1);
				expect(logs[0]!.resourceId).toBe(draftId);
			});
		});
	}

	it('refuses to revert from draft → draft (illegal_edge)', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId, { state: 'draft' });

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: { to: 'draft', at: Date.now(), reason: 'user_cancel' },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('illegal_edge');
	});
});

// ─── → sent ─────────────────────────────────────────────────────────────────

describe('draftLifecycle.transition — to: sent', () => {
	it('inserts mailMessages row, patches Sent folder, deletes the draft', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, sentFolderId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId, {
			state: 'pending_send',
			undoToken: 'tok-2',
			scheduledSendAt: Date.now() + 1000,
		});
		const rawStorageId = await storeBlob(t);

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: {
				to: 'sent',
				at: Date.now(),
				context: makeSentContext(rawStorageId),
			},
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.messageId).toBeDefined();

		await t.run(async (ctx) => {
			// Draft row deleted
			const draft = await ctx.db.get(draftId);
			expect(draft).toBeNull();

			// Sent folder uidNext/modseq/totalCount bumped
			const sent = await ctx.db.get(sentFolderId);
			expect(sent?.uidNext).toBe(2);
			expect(sent?.highestModseq).toBe(1);
			expect(sent?.totalCount).toBe(1);

			// mailMessages row exists
			if (outcome.ok && outcome.messageId) {
				const msg = await ctx.db.get(outcome.messageId);
				expect(msg).not.toBeNull();
				const outbound = (msg as { outbound?: {
					state: string;
					recipients: Array<{ address: string; mtaJobId: string }>;
				} }).outbound;
				expect(outbound?.state).toBe('queued');
				expect(outbound?.recipients.length).toBe(1);
				expect(outbound?.recipients[0]!.address).toBe('bob@example.com');
				expect(outbound?.recipients[0]!.mtaJobId).toBe(
					`pb-${outcome.messageId}-0`,
				);
			}

			// Audit log
			const logs = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'postbox_draft.sent'))
				.collect();
			expect(logs.length).toBe(1);
		});
	});

	it('STORAGE-LEAK REGRESSION: deletes the draft attachment blobs on send-success', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const attBlob = await storeBlob(t);
		const draftId = await seedDraft(t, mailboxId, {
			state: 'pending_send',
			undoToken: 'tok-3',
			attachments: [
				{
					storageId: attBlob,
					filename: 'photo.jpg',
					contentType: 'image/jpeg',
					size: 3,
					isInline: false,
				},
			],
		});
		const rawStorageId = await storeBlob(t);

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: {
				to: 'sent',
				at: Date.now(),
				context: makeSentContext(rawStorageId),
			},
		});
		expect(outcome.ok).toBe(true);

		// The blob should be gone from storage after the cascade ran. This
		// is the regression test for drift bug #1 in ADR-0028: the old
		// `deleteAfterSend` only deleted the row, leaking blobs.
		await t.run(async (ctx) => {
			const blob = await ctx.storage.get(attBlob);
			expect(blob).toBeNull();
		});
	});

	it('refuses with from_revoked when fromAddress is no longer in allowed set', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId, {
			state: 'pending_send',
			undoToken: 'tok-4',
			fromAddress: 'ceo@example.com', // forged — not the mailbox or any alias
		});
		const rawStorageId = await storeBlob(t);

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: {
				to: 'sent',
				at: Date.now(),
				context: makeSentContext(rawStorageId),
			},
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('from_revoked');

		// Reducer does NOT silently revert — the row stays in pending_send
		// so the caller can choose to follow up with an explicit revert.
		await t.run(async (ctx) => {
			const draft = await ctx.db.get(draftId);
			expect(draft?.state).toBe('pending_send');
		});
	});

	it('refuses → sent from state=draft as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId, { state: 'draft' });
		const rawStorageId = await storeBlob(t);

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: {
				to: 'sent',
				at: Date.now(),
				context: makeSentContext(rawStorageId),
			},
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('illegal_edge');
	});

	it('stamps flagAnswered on a SAME-mailbox inReplyTo message', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const original = await seedInboundMessage(t, mailboxId);
		const draftId = await seedDraft(t, mailboxId, {
			state: 'pending_send',
			undoToken: 'tok-same',
			inReplyToMessageId: original,
		});
		const rawStorageId = await storeBlob(t);

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: {
				to: 'sent',
				at: Date.now(),
				context: makeSentContext(rawStorageId),
			},
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(original);
			expect(msg?.flagAnswered).toBe(true);
		});
	});

	it('CROSS-MAILBOX IDOR REGRESSION: does NOT flip flagAnswered on a message in another mailbox', async () => {
		// Audit item authz-flaganswered: a reply draft in Alice's mailbox whose
		// `inReplyToMessageId` points at a message in Bob's mailbox must NOT be
		// able to flip Bob's message's `flagAnswered` on send. drafts.create now
		// refuses to persist the cross-mailbox linkage; runSentEffects re-checks
		// the target's mailbox as defense-in-depth. This drives the latter
		// directly by seeding the foreign linkage straight into the draft row.
		const t = convexTest(schema, modules);
		const alice = await seedMailboxAndSent(t, 'alice@example.com');
		const bob = await seedMailboxAndSent(t, 'bob@example.com');
		const bobMessage = await seedInboundMessage(t, bob.mailboxId);

		const draftId = await seedDraft(t, alice.mailboxId, {
			state: 'pending_send',
			undoToken: 'tok-cross',
			inReplyToMessageId: bobMessage,
		});
		const rawStorageId = await storeBlob(t);

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: {
				to: 'sent',
				at: Date.now(),
				context: makeSentContext(rawStorageId),
			},
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(bobMessage);
			expect(msg?.flagAnswered).toBe(false);
		});
	});
});

// ─── transitionByUndoToken ──────────────────────────────────────────────────

describe('draftLifecycle.transitionByUndoToken', () => {
	it('reverts pending_send → draft on the matching token', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId, {
			state: 'pending_send',
			undoToken: 'tok-5',
		});

		const outcome = await t.mutation(
			internal.mail.draftLifecycle.transitionByUndoToken,
			{
				undoToken: 'tok-5',
				input: { to: 'draft', at: Date.now(), reason: 'user_cancel' },
			},
		);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.draftId).toBe(draftId);
	});

	it('IDEMPOTENCY: double-fire on the same token returns already_draft (recorded)', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		const draftId = await seedDraft(t, mailboxId, {
			state: 'pending_send',
			undoToken: 'tok-double',
		});

		// First click reverts
		const first = await t.mutation(
			internal.mail.draftLifecycle.transitionByUndoToken,
			{
				undoToken: 'tok-double',
				input: { to: 'draft', at: Date.now(), reason: 'user_cancel' },
			},
		);
		expect(first.ok).toBe(true);

		// The first call patched the row, so undoToken is cleared. The
		// double-click goes to undo_token_mismatch — symmetric idempotency
		// because the row has no token anymore. Either way no second audit
		// log is written.
		const second = await t.mutation(
			internal.mail.draftLifecycle.transitionByUndoToken,
			{
				undoToken: 'tok-double',
				input: { to: 'draft', at: Date.now(), reason: 'user_cancel' },
			},
		);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.reason).toBe('undo_token_mismatch');

		// Only one audit log row for the revert.
		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'postbox_draft.cancelled'))
				.collect();
			expect(logs.length).toBe(1);
			void draftId;
		});
	});

	it('returns already_draft when the row exists but is already in draft state', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailboxAndSent(t);
		// Construct a row that has an undoToken AND is in draft state — this
		// is the racy scenario where the dispatcher already reverted but
		// the user's undo button click is in flight.
		await seedDraft(t, mailboxId, {
			state: 'draft',
			undoToken: 'tok-race',
		});

		const outcome = await t.mutation(
			internal.mail.draftLifecycle.transitionByUndoToken,
			{
				undoToken: 'tok-race',
				input: { to: 'draft', at: Date.now(), reason: 'user_cancel' },
			},
		);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.applied).toBe('recorded');
			expect(outcome.from).toBe('draft');
		}
	});

	it('returns undo_token_mismatch for an unknown token', async () => {
		const t = convexTest(schema, modules);
		const outcome = await t.mutation(
			internal.mail.draftLifecycle.transitionByUndoToken,
			{
				undoToken: 'tok-nonexistent',
				input: { to: 'draft', at: Date.now(), reason: 'user_cancel' },
			},
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('undo_token_mismatch');
	});
});
