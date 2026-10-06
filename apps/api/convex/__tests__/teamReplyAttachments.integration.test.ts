import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestContact,
	createTestConversationThread,
	createTestInboundMessage,
	createTestSemanticFile,
} from './factories';
import { recordUploadedBlob } from './uploadFixtures.testlib';
import { seedFolder, seedMailbox, seedMessage } from '../mail/__tests__/helpers.testlib';
import { conversationThreadsStep } from '../workspaces/deletion/steps/teamReplies';

// Team replies enqueue on the transactional workpool. Stub it so nothing is
// dispatched and the envelope the worker would get can be inspected.
const { enqueueActionMock } = vi.hoisted(() => ({
	enqueueActionMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: enqueueActionMock },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	EMAIL_WORKPOOL_RETRY_BEHAVIOR: { maxAttempts: 1 },
}));

const session = vi.hoisted(() => ({
	userId: 'user-A',
	activeOrganizationId: 'org-1',
	role: 'owner',
}));
vi.mock('../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../lib/sessionOrganization')),
	getMutationContext: vi.fn(async () => ({ ...session })),
	requireAdminContext: vi.fn(async () => ({ ...session })),
	requireOrgMember: vi.fn(async () => ({ ...session })),
	getBetterAuthSessionWithRole: vi.fn(async () => ({ ...session })),
	isActiveOrgMember: vi.fn(async () => true),
}));

const modules = import.meta.glob('../**/*.*s');
type Harness = TestConvex<typeof schema>;

beforeEach(() => {
	vi.useFakeTimers();
	enqueueActionMock.mockClear();
	session.userId = 'user-A';
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

/** An email thread with one inbound message in `status`, plus a sender identity. */
async function seedThread(
	t: Harness,
	status = 'draft_ready',
	overrides: { channel?: string; attachmentSuggestions?: unknown } = {}
) {
	return t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			contactCount: 0,
			createdAt: Date.now(),
			defaultFromEmail: 'support@owlat.example',
			defaultFromName: 'Northwind Studio',
		});
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'jonas@example.com' })
		);
		const { updatedAt: _u, channel: _c, ...thread } = createTestConversationThread({ contactId });
		const threadId = await ctx.db.insert('conversationThreads', {
			...thread,
			...(overrides.channel ? { channel: overrides.channel } : {}),
		});
		const messageId = await ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				threadId,
				contactId,
				from: 'Jonas Berg <jonas@example.com>',
				to: 'support@owlat.example',
				subject: 'September invoice',
				messageId: '<invoice-q@example.com>',
				processingStatus: status,
				draftResponse: 'Here is the invoice.',
				draftSubject: 'Re: September invoice',
				...(overrides.attachmentSuggestions
					? { attachmentSuggestions: overrides.attachmentSuggestions }
					: {}),
			})
		);
		return { threadId, messageId: messageId as Id<'inboundMessages'>, contactId };
	});
}

async function upload(t: Harness, bytes: BlobPart = 'invoice bytes', owner = 'user-A') {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob([bytes], { type: 'application/pdf' }));
		await recordUploadedBlob(ctx, storageId, owner);
		return storageId;
	});
}

async function seedFile(
	t: Harness,
	content = 'price list',
	overrides: Record<string, unknown> = {}
) {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob([content]));
		const fileId = await ctx.db.insert(
			'semanticFiles',
			createTestSemanticFile({ storageId, filename: 'prices.pdf', ...overrides })
		);
		return { fileId, storageId };
	});
}

async function blobText(t: Harness, storageId: Id<'_storage'>) {
	return t.run(async (ctx) => (await ctx.storage.get(storageId))?.text() ?? null);
}

async function threadAttachments(t: Harness, threadId: Id<'conversationThreads'>) {
	return t.run(async (ctx) => (await ctx.db.get(threadId))?.replyAttachments ?? []);
}

function lastEnvelope() {
	const calls = enqueueActionMock.mock.calls;
	return calls[calls.length - 1]?.[2]?.envelopeInput;
}

describe('team reply attachments: add, list, remove', () => {
	it('binds a fresh upload, lists it, and deletes its blob on remove', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		const storageId = await upload(t);

		const added = await t.mutation(api.inbox.replyAttachments.add, {
			threadId,
			storageId,
			filename: 'folder/invoice-2026-09.pdf',
			contentType: 'application/pdf',
		});
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({
			index: 0,
			filename: 'invoice-2026-09.pdf',
			contentType: 'application/pdf',
			size: 13,
			origin: 'upload',
			status: 'ready',
			addedBy: 'user-A',
		});
		expect(await t.query(api.inbox.replyAttachments.list, { threadId })).toEqual(added);
		const receipt = await t.run((ctx) =>
			ctx.db
				.query('storageUploads')
				.withIndex('by_storage', (q) => q.eq('storageId', storageId))
				.unique()
		);
		expect(receipt).toMatchObject({ status: 'bound', resourceKey: `teamReply:${threadId}` });

		expect(await t.mutation(api.inbox.replyAttachments.remove, { threadId, index: 0 })).toEqual([]);
		expect(await threadAttachments(t, threadId)).toEqual([]);
		expect(await blobText(t, storageId)).toBeNull();
		await expect(
			t.mutation(api.inbox.replyAttachments.remove, { threadId, index: 0 })
		).rejects.toThrow(/no attachment at that position/);
	});

	it('removes by id the entry a stale index no longer points at, once', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		const first = await upload(t, 'terms');
		const second = await upload(t, 'salary');
		await t.mutation(api.inbox.replyAttachments.add, {
			threadId,
			storageId: first,
			filename: 'terms.pdf',
		});
		const added = await t.mutation(api.inbox.replyAttachments.add, {
			threadId,
			storageId: second,
			filename: 'salary.xlsx',
		});
		const salary = added[1]!;
		// A teammate removes the earlier file, so index 1 is past the end now.
		await t.mutation(api.inbox.replyAttachments.remove, { threadId, index: 0 });

		const left = await t.mutation(api.inbox.replyAttachments.remove, {
			threadId,
			index: salary.index,
			id: salary.id,
		});
		expect(left).toEqual([]);
		expect(await blobText(t, second)).toBeNull();
		// Already gone: nothing to remove, and no error.
		expect(
			await t.mutation(api.inbox.replyAttachments.remove, {
				threadId,
				index: salary.index,
				id: salary.id,
			})
		).toEqual([]);
	});

	it('removes by id only that entry, leaving the one now at its old index', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		const ids = [await upload(t, 'a'), await upload(t, 'b'), await upload(t, 'c')];
		const lists = [];
		for (const [i, storageId] of ids.entries()) {
			lists.push(
				await t.mutation(api.inbox.replyAttachments.add, {
					threadId,
					storageId,
					filename: `f${i}.pdf`,
				})
			);
		}
		const target = lists[2]![1]!;
		// f0 goes, so f1 moves to index 0 and f2 now sits at f1's old index.
		await t.mutation(api.inbox.replyAttachments.remove, { threadId, index: 0 });

		const left = await t.mutation(api.inbox.replyAttachments.remove, {
			threadId,
			index: target.index,
			id: target.id,
		});
		expect(left.map((entry) => entry.filename)).toEqual(['f2.pdf']);
		expect(await blobText(t, ids[1]!)).toBeNull();
		expect(await blobText(t, ids[2]!)).toBe('c');
	});

	it("refuses someone else's upload and an untracked blob, leaving both in place", async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		const foreign = await upload(t, 'theirs', 'user-B');
		const untracked = await t.run((ctx) => ctx.storage.store(new Blob(['private mail'])));
		for (const storageId of [foreign, untracked]) {
			await expect(
				t.mutation(api.inbox.replyAttachments.add, { threadId, storageId, filename: 'x.pdf' })
			).rejects.toThrow(/not an unclaimed upload/);
			expect(await blobText(t, storageId)).not.toBeNull();
		}
		expect(await threadAttachments(t, threadId)).toEqual([]);
	});

	it('enforces the Postbox draft limits: count and total size', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		for (let i = 0; i < 10; i++) {
			await t.mutation(api.inbox.replyAttachments.add, {
				threadId,
				storageId: await upload(t, `file ${i}`),
				filename: `f${i}.txt`,
			});
		}
		const eleventh = await upload(t, 'one too many');
		await expect(
			t.mutation(api.inbox.replyAttachments.add, { threadId, storageId: eleventh })
		).rejects.toThrow(/Too many attachments/);
		// The refused upload stays unclaimed, so the upload cleanup reclaims it.
		const receipt = await t.run((ctx) =>
			ctx.db
				.query('storageUploads')
				.withIndex('by_storage', (q) => q.eq('storageId', eleventh))
				.unique()
		);
		expect(receipt?.status).toBe('uploaded');

		const other = await seedThread(t);
		const sixMb = new Uint8Array(6 * 1024 * 1024);
		await t.mutation(api.inbox.replyAttachments.add, {
			threadId: other.threadId,
			storageId: await upload(t, sixMb),
			filename: 'a.pdf',
		});
		await expect(
			t.mutation(api.inbox.replyAttachments.add, {
				threadId: other.threadId,
				storageId: await upload(t, sixMb),
				filename: 'b.pdf',
			})
		).rejects.toThrow(/total size limit/);
	});

	it('refuses attachments on a non-email thread', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t, 'draft_ready', { channel: 'sms' });
		await expect(
			t.mutation(api.inbox.replyAttachments.add, { threadId, storageId: await upload(t) })
		).rejects.toThrow(/only be sent on email threads/);
	});
});

describe('team reply attachments: attaching an existing file', () => {
	it('copies a Files row into a blob the reply owns', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		const { fileId, storageId: sourceBlob } = await seedFile(t);

		const pending = await t.mutation(api.inbox.replyAttachments.attachExisting, {
			threadId,
			source: 'semanticFile',
			id: fileId,
		});
		expect(pending[0]).toMatchObject({ status: 'copying', origin: 'semanticFile', url: null });
		// A person cannot send while it is still copying.
		const { messageId } = await t.run(async (ctx) => {
			const message = await ctx.db
				.query('inboundMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.first();
			return { messageId: message!._id };
		});
		await expect(
			t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId })
		).rejects.toThrow(/still being attached/);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const [entry] = await threadAttachments(t, threadId);
		expect(entry).toMatchObject({ origin: 'semanticFile', sourceId: fileId, size: 10 });
		expect(entry?.storageId).toBeDefined();
		expect(entry?.storageId).not.toBe(sourceBlob);
		// The copy outlives the source: the retention sweep or a delete in Files
		// can take the original without touching the reply.
		await t.run((ctx) => ctx.storage.delete(sourceBlob));
		expect(await blobText(t, entry!.storageId!)).toBe('price list');

		// Attaching the same file again is a no-op.
		expect(
			await t.mutation(api.inbox.replyAttachments.attachExisting, {
				threadId,
				source: 'semanticFile',
				id: fileId,
			})
		).toHaveLength(1);
	});

	it('refuses a Files row whose bytes were released, and an id that is not one', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		const released = await t.run((ctx) =>
			ctx.db.insert('semanticFiles', createTestSemanticFile({ storageId: undefined }))
		);
		await expect(
			t.mutation(api.inbox.replyAttachments.attachExisting, {
				threadId,
				source: 'semanticFile',
				id: released,
			})
		).rejects.toThrow(/no longer stored/);
		await expect(
			t.mutation(api.inbox.replyAttachments.attachExisting, {
				threadId,
				source: 'semanticFile',
				id: 'not-an-id',
			})
		).rejects.toThrow(/not found/i);
	});

	const EML = [
		'From: a@example.com',
		'To: me@example.com',
		'Subject: Invoice',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="b1"',
		'',
		'--b1',
		'Content-Type: text/plain',
		'',
		'See attached.',
		'--b1',
		'Content-Type: text/plain; name="invoice.txt"',
		'Content-Disposition: attachment; filename="invoice.txt"',
		'Content-Transfer-Encoding: base64',
		'',
		'SW52b2ljZSAjNDI=',
		'--b1--',
		'',
	].join('\r\n');

	async function seedMailAttachment(t: Harness, organizationId = 'org-1') {
		const mailboxId = await seedMailbox(t, {
			userId: 'user-B',
			organizationId,
			address: 'b@owlat.test',
		});
		await seedFolder(t, mailboxId);
		const messageId = await seedMessage(t, mailboxId, { subject: 'Invoice' });
		return t.run(async (ctx) => {
			const rawStorageId = await ctx.storage.store(new Blob([EML]));
			await ctx.db.patch(messageId, { rawStorageId });
			return ctx.db.insert('mailAttachments', {
				mailboxId,
				messageId,
				filename: 'invoice.txt',
				contentType: 'text/plain',
				size: 11,
				receivedAt: Date.now(),
				fromAddress: 'a@example.com',
				partIndex: '0',
			});
		});
	}

	// A team-inbox caller is an owner or admin, and the mailbox gate lets those
	// read every mailbox of their organization (`mail/permissions.ts`).
	it('copies an attachment out of a received email the caller can read', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		const attachmentId = await seedMailAttachment(t);
		await t.mutation(api.inbox.replyAttachments.attachExisting, {
			threadId,
			source: 'mailAttachment',
			id: attachmentId,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const [entry] = await threadAttachments(t, threadId);
		expect(entry).toMatchObject({ filename: 'invoice.txt', origin: 'mailAttachment', size: 11 });
		expect(await blobText(t, entry!.storageId!)).toBe('Invoice #42');
	});

	it('refuses an attachment in a mailbox the caller cannot open', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		const attachmentId = await seedMailAttachment(t, 'org-2');
		await expect(
			t.mutation(api.inbox.replyAttachments.attachExisting, {
				threadId,
				source: 'mailAttachment',
				id: attachmentId,
			})
		).rejects.toThrow(/not accessible/);
		expect(await threadAttachments(t, threadId)).toEqual([]);
	});
});

describe('team reply attachments: the send paths', () => {
	it('an approved reply carries the composer attachments, and the message keeps them', async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId } = await seedThread(t);
		const storageId = await upload(t);
		await t.mutation(api.inbox.replyAttachments.add, {
			threadId,
			storageId,
			filename: 'invoice.pdf',
		});

		const approved = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});
		expect(approved.success).toBe(true);
		// The undo window: the composer still holds them until the send fires.
		expect(await threadAttachments(t, threadId)).toHaveLength(1);

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
		});

		expect(lastEnvelope()?.attachmentRefs).toEqual([
			expect.objectContaining({ filename: 'invoice.pdf', storageId }),
		]);
		const [thread, message, sends] = await t.run(async (ctx) => [
			await ctx.db.get(threadId),
			await ctx.db.get(messageId),
			await ctx.db.query('transactionalSends').collect(),
		]);
		expect(thread?.replyAttachments).toBeUndefined();
		expect(message?.replyAttachments).toEqual([
			expect.objectContaining({ storageId, filename: 'invoice.pdf' }),
		]);
		// Not on the Send row: the Send lifecycle deletes those blobs once it settles.
		expect(sends).toHaveLength(1);
		expect(sends[0]?.attachmentStorageIds).toBeUndefined();
		expect(await blobText(t, storageId)).toBe('invoice bytes');
	});

	it('a manual reply (taken over, typed, approved) sends what was attached', async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId } = await seedThread(t, 'failed');
		await t.mutation(api.inbox.replyAttachments.add, {
			threadId,
			storageId: await upload(t),
			filename: 'invoice.pdf',
		});
		await t.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId });
		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: 'Attached, as promised.',
		});
		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });
		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
		});
		const envelope = lastEnvelope();
		expect(envelope?.template?.htmlContent).toContain('Attached, as promised.');
		expect(envelope?.attachmentRefs).toEqual([
			expect.objectContaining({ filename: 'invoice.pdf' }),
		]);
	});

	it('the autonomous send never picks up the unconfirmed suggestion', async () => {
		const t = convexTest(schema, modules);
		const { fileId, storageId } = await seedFile(t);
		const { threadId, messageId } = await seedThread(t, 'approved', {
			attachmentSuggestions: {
				query: 'price list',
				ambiguous: false,
				candidates: [
					{
						fileId,
						storageId,
						filename: 'prices.pdf',
						mimeType: 'application/pdf',
						fileSize: 10,
						score: 0.9,
					},
				],
			},
		});
		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			autonomous: true,
		});
		expect(enqueueActionMock).toHaveBeenCalledTimes(1);
		expect(lastEnvelope()?.attachmentRefs).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get(messageId)))?.replyAttachments).toBeUndefined();
		// The suggestion is still on offer for a person to confirm.
		expect(await t.query(api.inbox.replyAttachments.suggestions, { threadId })).not.toBeNull();
	});

	it('the autonomous send waits for a file attached for this message to finish copying', async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId } = await seedThread(t, 'approved');
		vi.advanceTimersByTime(60_000);
		await t.mutation(api.inbox.replyAttachments.add, {
			threadId,
			storageId: await upload(t),
			filename: 'invoice.pdf',
		});
		const { fileId } = await seedFile(t);
		await t.mutation(api.inbox.replyAttachments.attachExisting, {
			threadId,
			source: 'semanticFile',
			id: fileId,
		});

		// Delay 0: the send fires while the Files copy is still running.
		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			autonomous: true,
		});
		expect(enqueueActionMock).not.toHaveBeenCalled();
		expect((await threadAttachments(t, threadId)).map((entry) => entry.origin)).toEqual([
			'upload',
			'semanticFile',
		]);

		// The copy lands, and the retried send carries both files.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(enqueueActionMock).toHaveBeenCalledTimes(1);
		expect(lastEnvelope()?.attachmentRefs).toEqual([
			expect.objectContaining({ filename: 'invoice.pdf' }),
			expect.objectContaining({ filename: 'prices.pdf' }),
		]);
		expect(await threadAttachments(t, threadId)).toEqual([]);
	});

	describe('a send waiting on a copy stays cancellable', () => {
		/** An approved message whose send fired while a Files pick is still copying. */
		async function heldSend(t: Harness) {
			const { threadId, messageId } = await seedThread(t, 'approved');
			vi.advanceTimersByTime(60_000);
			const { fileId } = await seedFile(t);
			await t.mutation(api.inbox.replyAttachments.attachExisting, {
				threadId,
				source: 'semanticFile',
				id: fileId,
			});
			await t.action(internal.agent.agentPipeline.sendApprovedReply, {
				inboundMessageId: messageId,
				autonomous: true,
			});
			return { threadId, messageId };
		}

		it('points the undo marker at the waiting send, and Undo pulls it back', async () => {
			const t = convexTest(schema, modules);
			const { messageId } = await heldSend(t);
			const marker = await t.run(async (ctx) => {
				const message = (await ctx.db.get(messageId))!;
				const job = message.pendingAutoSend
					? await ctx.db.system.get(message.pendingAutoSend.scheduledFnId)
					: null;
				return { state: job?.state.kind, name: job?.name };
			});
			expect(marker).toEqual({ state: 'pending', name: 'agent/agentPipeline:sendApprovedReply' });

			const outcome = await t.mutation(internal.inbox.processingLifecycle.cancelAutoSend, {
				inboundMessageId: messageId,
				reason: 'user_cancel',
				userId: 'user-A',
			});
			expect(outcome).toEqual({ cancelled: true, reason: 'cancelled' });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(enqueueActionMock).not.toHaveBeenCalled();
			expect((await t.run((ctx) => ctx.db.get(messageId)))?.processingStatus).toBe('draft_ready');
		});

		it('the kill switch pulls a waiting send back', async () => {
			const t = convexTest(schema, modules);
			const { messageId } = await heldSend(t);
			const { cancelled } = await t.mutation(
				internal.inbox.processingLifecycle.cancelPendingAutoSendsForKillSwitch,
				{}
			);
			expect(cancelled).toBe(1);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(enqueueActionMock).not.toHaveBeenCalled();
			expect((await t.run((ctx) => ctx.db.get(messageId)))?.processingStatus).toBe('draft_ready');
		});

		it('the wait ends without sending once the message is no longer approved', async () => {
			const t = convexTest(schema, modules);
			const { messageId } = await heldSend(t);
			await t.run(async (ctx) => {
				await ctx.db.patch(messageId, { processingStatus: 'draft_ready' });
			});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(enqueueActionMock).not.toHaveBeenCalled();
		});
	});

	it("a person's approved send waits for a file attached inside the undo window", async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId } = await seedThread(t, 'approved');
		const { fileId } = await seedFile(t);
		await t.mutation(api.inbox.replyAttachments.attachExisting, {
			threadId,
			source: 'semanticFile',
			id: fileId,
		});
		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
		});
		expect(enqueueActionMock).not.toHaveBeenCalled();
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(lastEnvelope()?.attachmentRefs).toEqual([
			expect.objectContaining({ filename: 'prices.pdf' }),
		]);
	});

	it('the autonomous send stops when a file attached for this message failed to copy', async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId } = await seedThread(t, 'approved');
		vi.advanceTimersByTime(60_000);
		const { fileId, storageId } = await seedFile(t);
		await t.mutation(api.inbox.replyAttachments.attachExisting, {
			threadId,
			source: 'semanticFile',
			id: fileId,
		});
		// The bytes go before the copy runs, so the copy fails.
		await t.run(async (ctx) => {
			await ctx.storage.delete(storageId);
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await threadAttachments(t, threadId))[0]?.copyError).toBeDefined();

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			autonomous: true,
		});
		expect(enqueueActionMock).not.toHaveBeenCalled();
		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('failed');
	});

	it('the autonomous send leaves a file staged before the message arrived; a person sends it', async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId } = await seedThread(t, 'approved');
		await t.mutation(api.inbox.replyAttachments.add, {
			threadId,
			storageId: await upload(t),
			filename: 'staged-for-my-own-reply.pdf',
		});
		// The customer wrote again after the file was staged in the composer.
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { receivedAt: Date.now() + 60_000 });
		});

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			autonomous: true,
		});
		expect(enqueueActionMock).toHaveBeenCalledTimes(1);
		expect(lastEnvelope()?.attachmentRefs).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get(messageId)))?.replyAttachments).toBeUndefined();
		expect((await threadAttachments(t, threadId)).map((entry) => entry.filename)).toEqual([
			'staged-for-my-own-reply.pdf',
		]);

		// A person approving a reply on the same thread sends what the composer shows.
		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
		});
		expect(lastEnvelope()?.attachmentRefs).toEqual([
			expect.objectContaining({ filename: 'staged-for-my-own-reply.pdf' }),
		]);
		expect(await threadAttachments(t, threadId)).toEqual([]);
	});

	it("a file answered to the agent's question leaves with the autonomous reply", async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seedThread(t, 'awaiting_clarification');
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, {
				pendingClarification: {
					questions: [
						{
							id: 'clarify_attachment',
							slotType: 'attachment',
							answerKind: 'file',
							text: 'They asked for the invoice. I could not find it.',
						},
					],
					askedAt: Date.now(),
				},
			});
		});
		vi.advanceTimersByTime(60_000);
		const storageId = await upload(t);
		await t.mutation(api.inbox.clarification.answerClarification, {
			inboundMessageId: messageId,
			answers: [
				{
					questionId: 'clarify_attachment',
					file: { source: 'upload', id: storageId, filename: 'invoice.pdf' },
					keepCopy: false,
				},
			],
		});
		// The resumed draft is routed to an unattended send.
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { processingStatus: 'approved' });
		});
		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			autonomous: true,
		});
		expect(lastEnvelope()?.attachmentRefs).toEqual([
			expect.objectContaining({ filename: 'invoice.pdf', storageId }),
		]);
	});

	it('a follow-up takes the attachments, Undo hands them back, and the dispatch sends them', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t, 'sent');
		const storageId = await upload(t);
		await t.mutation(api.inbox.replyAttachments.add, {
			threadId,
			storageId,
			filename: 'invoice.pdf',
		});

		const first = await t.mutation(api.inbox.followUps.sendFollowUp, {
			threadId,
			body: 'Forgot the file.',
			subject: '',
		});
		if (!first.success) throw new Error('expected a scheduled follow-up');
		expect(await threadAttachments(t, threadId)).toEqual([]);
		expect((await t.run((ctx) => ctx.db.get(first.followUpId)))?.attachments).toHaveLength(1);

		await t.mutation(api.inbox.followUps.cancelFollowUp, { followUpId: first.followUpId });
		expect((await threadAttachments(t, threadId)).map((entry) => entry.storageId)).toEqual([
			storageId,
		]);

		const second = await t.mutation(api.inbox.followUps.sendFollowUp, {
			threadId,
			body: 'Forgot the file.',
			subject: '',
		});
		if (!second.success) throw new Error('expected a scheduled follow-up');
		await t.mutation(internal.inbox.followUps.dispatch, { followUpId: second.followUpId });
		expect(lastEnvelope()?.attachmentRefs).toEqual([
			expect.objectContaining({ filename: 'invoice.pdf', storageId }),
		]);
		const listed = await t.query(api.inbox.followUps.listForThread, { threadId });
		expect(listed[listed.length - 1]?.attachments).toEqual([
			expect.objectContaining({ storageId }),
		]);
	});
});

describe('team replies with Answer mode gaps', () => {
	/** An ask session on the thread, as "Draft with AI" leaves one. */
	async function drafted(t: Harness, threadId: Id<'conversationThreads'>) {
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('answerAskSessions', {
				ownerId: 'user-B',
				organizationId: 'org-1',
				target: { kind: 'teamThread', threadId },
				targetKey: `teamThread:${threadId}`,
				locale: 'en',
				round: 1,
				status: 'ready',
				questions: [],
				attachedFiles: [],
				createdAt: now,
				updatedAt: now,
			});
		});
	}
	const gapped = 'Hi Jonas, [[attach the September invoice]]';
	const refused = { data: { category: 'invalid_state', data: { code: 'DRAFT_HAS_GAPS' } } };

	it('approving a reply with a gap left is refused once someone drafted with AI', async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId } = await seedThread(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { draftResponse: gapped });
		});
		await drafted(t, threadId);

		await expect(
			t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId })
		).rejects.toMatchObject(refused);

		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: 'Hi Jonas, the invoice is attached.',
		});
		const approved = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});
		expect(approved.success).toBe(true);
	});

	it('leaves hand-written double brackets alone on a thread nobody drafted with AI', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seedThread(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { draftResponse: 'See [[wiki link]].' });
		});
		const approved = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});
		expect(approved.success).toBe(true);
	});

	it('a follow-up with a gap left is refused', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t, 'sent');
		await drafted(t, threadId);
		await expect(
			t.mutation(api.inbox.followUps.sendFollowUp, { threadId, body: gapped, subject: '' })
		).rejects.toMatchObject(refused);
	});
});

describe('team reply attachments: suggestions and cleanup', () => {
	it("offers the newest message's stored suggestion until one of its files is attached", async () => {
		const t = convexTest(schema, modules);
		const { fileId, storageId } = await seedFile(t);
		const released = await t.run((ctx) =>
			ctx.db.insert('semanticFiles', createTestSemanticFile({ storageId: undefined }))
		);
		const candidate = (id: Id<'semanticFiles'>) => ({
			fileId: id,
			storageId,
			filename: 'prices.pdf',
			mimeType: 'application/pdf',
			fileSize: 10,
			score: 0.8,
		});
		const { threadId } = await seedThread(t, 'draft_ready', {
			attachmentSuggestions: {
				query: 'price list',
				ambiguous: true,
				candidates: [candidate(fileId), candidate(released)],
			},
		});

		const offered = await t.query(api.inbox.replyAttachments.suggestions, { threadId });
		// The released file is dropped, which leaves a single, unambiguous pick.
		expect(offered).toMatchObject({ query: 'price list', ambiguous: false });
		expect(offered?.candidates.map((c) => c.fileId)).toEqual([fileId]);

		await t.mutation(api.inbox.replyAttachments.attachExisting, {
			threadId,
			source: 'semanticFile',
			id: fileId,
		});
		expect(await t.query(api.inbox.replyAttachments.suggestions, { threadId })).toBeNull();
	});

	it('deleting the workspace deletes the blobs the composer holds', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		const storageId = await upload(t);
		await t.mutation(api.inbox.replyAttachments.add, { threadId, storageId, filename: 'a.pdf' });
		await t.run(async (ctx) => {
			await conversationThreadsStep.deleteBatch(ctx);
		});
		expect(await t.run((ctx) => ctx.db.get(threadId))).toBeNull();
		expect(await blobText(t, storageId)).toBeNull();
	});
});
