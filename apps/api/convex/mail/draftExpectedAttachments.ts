/**
 * Files a Postbox draft was opened to carry, owed by the draft until each one
 * is attached (#1257): the generated `.ics` an RSVP answers with, and the
 * attachments of a forwarded (or resent) message.
 *
 * WHY ON THE ROW. The composer used to hand these over in memory and upload
 * them itself. A reload while one was still uploading lost it: the reopened
 * draft had the text and not the file, and Send went out without it. Kept in
 * one tab's storage instead, another tab (or a duplicated one) still could not
 * see what was owed, and two tabs could each attach a copy. So the draft row
 * holds the debt, and every tab reads the same answer:
 *
 *  - `drafts.create` writes the owed list in the mutation that creates the row,
 *    so no draft exists without it. A generated file is stored whole (it cannot
 *    be made again, so it is bounded). A forward is one debt for the message's
 *    attachments; nobody picks its parts before the server reads the message.
 *  - `fulfil` (draftExpectedAttachmentsFulfil.ts, any tab, any number of times)
 *    reads each forwarded message's raw MIME once, picks its parts with the
 *    shared `forwardedParts` (the disposition rule forwarding always used),
 *    expands the debt into one entry per part keyed by the raw part index
 *    (`expandForward`, once), and copies each part's bytes from that same
 *    parse. Each copy is receipted as an unclaimed upload the moment it is
 *    stored (`stageCopy`), so one that is never bound is deleted by the upload
 *    sweep; `bindExpected` settles one key exactly once by binding that
 *    receipt, and a second copy of a settled or removed key is dropped.
 *  - Taking a file out settles it as removed, on every path: `remove` here
 *    (which also takes out a copy that already landed; a forward's key covers
 *    the whole forward, before or after it was expanded), `drafts.removeAttachment` and
 *    share-as-link (`withoutAttachment`). A copy still in flight then has
 *    nothing to come back to.
 *  - `drafts.send` refuses while anything is owed (`DRAFT_ATTACHMENTS_OWED`),
 *    an unexpanded forward included.
 *
 * Whatever cannot be copied (a message gone or not readable by this caller,
 * a compose limit) stays owed: the composer shows a failed chip with Retry and
 * Remove.
 */

import { v, type Infer } from 'convex/values';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { Doc, Id } from '../_generated/dataModel';
import { postboxMutation } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { assertStateIs } from './draftLifecycle/reducers';
import {
	consumeUpload,
	deleteOwnedUpload,
	dropUnclaimedUpload,
	stageServerUpload,
	storedFileSize,
} from '../storage/uploads';
import { getMutationContext } from '../lib/sessionOrganization';
import { openMessageBody, sealBodyAtWrite } from '../lib/messageBody';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import type {
	expectedAttachmentRequestValidator,
	mailDraftExpectedAttachmentValidator,
} from '../lib/validators/mailContent';
import { getOrThrow, throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';

type ExpectedAttachment = Infer<typeof mailDraftExpectedAttachmentValidator>;
type ExpectedAttachmentRequest = Infer<typeof expectedAttachmentRequestValidator>;

/** A generated file is kept whole on the row while it is owed (UTF-8 bytes). An RSVP is a few KB. */
export const MAX_GENERATED_ATTACHMENT_BYTES = 64 * 1024;
/**
 * Files one forward may expand into. The MIME walker keeps at most 1000 parts
 * of a message and an entry is a few hundred bytes (its filename capped at
 * 255), so the list stays far below the row size limit. Past it the forward is
 * not expanded: it stays owed, as one failed chip, until removed.
 */
export const MAX_FORWARDED_PARTS = 1000;

/** Why an owed file was not attached this time; it stays owed. */
export type FulfilFailure =
	| 'unreadable'
	| 'tooLarge'
	| 'tooMany'
	| 'totalTooLarge'
	| 'failed'
	/** A forwarded message too large to read within the action's memory. */
	| 'messageTooLarge'
	/** A forwarded message the MIME walker could not read to the end (parts, depth). */
	| 'messageTooComplex';

/** The key a forwarded part is owed under: the message and its raw part index. */
export function forwardPartKey(messageId: Id<'mailMessages'>, partIndex: string): string {
	return `forward:${messageId}:${partIndex}`;
}

/**
 * The owed list for a new draft. A forward is one debt for the message's
 * attachments, which `fulfil` expands from the raw message; the caller must be
 * able to read it (a message already gone still owes, as that debt).
 */
export async function expectedAttachmentsFor(
	ctx: MutationCtx,
	requests: readonly ExpectedAttachmentRequest[]
): Promise<ExpectedAttachment[]> {
	const owed: ExpectedAttachment[] = [];
	for (const [index, request] of requests.entries()) {
		if (request.kind === 'forward') {
			const message = await ctx.db.get(request.messageId);
			if (message && !(await requireMailboxAccess(ctx, message.mailboxId)).ok) {
				throwForbidden('Message not accessible');
			}
			owed.push({
				key: `forward:${request.messageId}`,
				filename: '',
				contentType: 'application/octet-stream',
				size: 0,
				source: { kind: 'forwardMessage', messageId: request.messageId },
				state: 'owed',
				isPlaceholder: true,
			});
			continue;
		}
		const size = new TextEncoder().encode(request.content).byteLength;
		if (size > MAX_GENERATED_ATTACHMENT_BYTES) {
			throwInvalidInput('The generated attachment is too large');
		}
		owed.push({
			key: `generated:${index}`,
			filename: request.filename.slice(0, 255),
			contentType: request.contentType,
			size,
			// Sealed at rest like the draft's body: an RSVP names the event.
			source: { kind: 'generated', content: await sealBodyAtWrite(request.content) },
			state: 'owed',
		});
	}
	return owed;
}

/** `drafts.send`: nothing may go out while the draft still owes a file. */
export function assertNothingOwed(draft: Doc<'mailDrafts'>): void {
	if (draft.expectedAttachments?.some((entry) => entry.state === 'owed')) {
		throwInvalidState('An attachment is still being added to this message', {
			code: 'DRAFT_ATTACHMENTS_OWED',
		});
	}
}

/** The owed list as clients read it: a generated file's text stays on the server. */
export function expectedAttachmentsView(
	entries: readonly ExpectedAttachment[] | undefined
): ExpectedAttachment[] | undefined {
	return entries?.map((entry) =>
		entry.source.kind === 'generated' ? { ...entry, source: { kind: 'generated' } } : entry
	);
}

/** Settle one entry: its text is no longer needed once it is attached or removed. */
function settled(
	entry: ExpectedAttachment,
	state: 'attached' | 'removed',
	storageId?: Id<'_storage'>
): ExpectedAttachment {
	return {
		...entry,
		state,
		storageId,
		source: entry.source.kind === 'generated' ? { kind: 'generated' } : entry.source,
	};
}

/**
 * The draft without one attachment: every path that takes a file out (remove,
 * share as a link) also settles an owed file that blob carried as removed, so
 * no tab shows it again and nothing attaches it again.
 */
export function withoutAttachment(
	draft: Pick<Doc<'mailDrafts'>, 'attachments' | 'expectedAttachments'>,
	storageId: Id<'_storage'>
): Pick<Doc<'mailDrafts'>, 'attachments' | 'expectedAttachments'> {
	const entries = draft.expectedAttachments;
	return {
		attachments: draft.attachments.filter((a) => a.storageId !== storageId),
		...(entries?.some((e) => e.storageId === storageId)
			? {
					expectedAttachments: entries.map((e) =>
						e.storageId === storageId ? settled(e, 'removed') : e
					),
				}
			: {}),
	};
}

/** What `fulfil` has to do for a draft, as read by a caller who can write it. */
export type OwedWork =
	| { kind: 'unreadable'; key: string; filename: string }
	| { kind: 'generated'; key: string; filename: string; contentType: string; content: string }
	| {
			kind: 'forward';
			messageId: Id<'mailMessages'>;
			rawStorageId: Id<'_storage'>;
			/** The raw message's size in bytes (the larger of the row's and the blob's). */
			rawSize: number;
			/** The message's unexpanded debt, when it still has one. */
			debtKey?: string;
			/** Parts already owed under their own keys. */
			partIndexes: string[];
	  };

/**
 * What the draft owes, for a caller who can write it. A forwarded message the
 * caller cannot read (or that is gone) is reported unreadable: another member
 * may be able to copy it.
 */
export const owedWork = internalQuery({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args): Promise<OwedWork[]> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) return [];
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		if (draft.state !== 'draft') return [];
		const work: OwedWork[] = [];
		const forwards = new Map<string, Extract<OwedWork, { kind: 'forward' }>>();
		for (const entry of draft.expectedAttachments ?? []) {
			if (entry.state !== 'owed') continue;
			const { key, filename, contentType, source } = entry;
			if (source.kind === 'generated') {
				work.push(
					source.content === undefined
						? { kind: 'unreadable', key, filename }
						: {
								kind: 'generated',
								key,
								filename,
								contentType,
								content: await openMessageBody(source.content),
							}
				);
				continue;
			}
			const message = await ctx.db.get(source.messageId);
			const readable = message ? await requireMailboxAccess(ctx, message.mailboxId) : null;
			if (!message || !readable?.ok) {
				work.push({ kind: 'unreadable', key, filename });
				continue;
			}
			let job = forwards.get(message._id);
			if (!job) {
				job = {
					kind: 'forward',
					messageId: message._id,
					rawStorageId: message.rawStorageId,
					rawSize: Math.max(
						message.rawSize,
						(await ctx.db.system.get(message.rawStorageId))?.size ?? 0
					),
					partIndexes: [],
				};
				forwards.set(message._id, job);
				work.push(job);
			}
			if (source.kind === 'forwardMessage') job.debtKey = key;
			else job.partIndexes.push(source.partIndex);
		}
		return work;
	},
});

/**
 * Expand a forward's debt into one owed entry per part, as `forwardedParts`
 * picked them from the raw message, once: a second expansion (another tab)
 * finds the debt gone and changes nothing. Removing the debt first removes the
 * whole forward. Returns the parts now owed for that message.
 */
export const expandForward = internalMutation({
	args: {
		draftId: v.id('mailDrafts'),
		key: v.string(),
		parts: v.array(
			v.object({
				partIndex: v.string(),
				filename: v.string(),
				contentType: v.string(),
				size: v.number(),
			})
		),
	},
	handler: async (
		ctx,
		args
	): Promise<{ outcome: 'expanded' | 'taken' | 'tooMany'; owed: string[] }> => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		const entries = draft.expectedAttachments ?? [];
		const debt = entries.find((e) => e.key === args.key);
		const messageId = debt?.source.kind === 'forwardMessage' ? debt.source.messageId : null;
		const owedParts = (list: typeof entries) =>
			list.flatMap((e) =>
				e.state === 'owed' && e.source.kind === 'forward' && e.key.startsWith(`${args.key}:`)
					? [e.source.partIndex]
					: []
			);
		if (!debt || debt.state !== 'owed' || !messageId) {
			return { outcome: 'taken', owed: owedParts(entries) };
		}
		if (args.parts.length > MAX_FORWARDED_PARTS) return { outcome: 'tooMany', owed: [] };
		const expanded = entries.flatMap((e): ExpectedAttachment[] =>
			e.key !== args.key
				? [e]
				: args.parts.map((part) => ({
						key: forwardPartKey(messageId, part.partIndex),
						filename: part.filename.slice(0, 255),
						contentType: part.contentType,
						size: part.size,
						source: { kind: 'forward', messageId, partIndex: part.partIndex },
						state: 'owed',
					}))
		);
		await ctx.db.patch(args.draftId, { expectedAttachments: expanded, lastEditedAt: Date.now() });
		return { outcome: 'expanded', owed: owedParts(expanded) };
	},
});

/**
 * Receipt a copy right after it is stored, as an unclaimed upload: if it is
 * never bound (the action dies, deleting a losing copy fails), the upload
 * sweep deletes it like any upload nobody attached.
 */
export const stageCopy = internalMutation({
	args: { storageId: v.id('_storage') },
	handler: async (ctx, args) => {
		await stageServerUpload(ctx, args.storageId, await getMutationContext(ctx));
	},
});

/** Delete a copy that was not bound (it lost, or a limit refused it), with its receipt. */
export const dropCopy = internalMutation({
	args: { storageId: v.id('_storage') },
	handler: async (ctx, args) => {
		await dropUnclaimedUpload(ctx, args.storageId);
	},
});

/**
 * Put a copied blob on the draft for one owed key, exactly once. `taken` means
 * the key was already settled (another tab attached it, or the person removed
 * it): the caller deletes the blob. A compose limit leaves the key owed.
 */
export const bindExpected = internalMutation({
	args: { draftId: v.id('mailDrafts'), key: v.string(), storageId: v.id('_storage') },
	handler: async (
		ctx,
		args
	): Promise<{ outcome: 'bound' | 'taken' | 'tooLarge' | 'tooMany' | 'totalTooLarge' }> => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		const entries = draft.expectedAttachments ?? [];
		const entry = entries.find((e) => e.key === args.key);
		if (!entry || entry.state !== 'owed') return { outcome: 'taken' };
		if (draft.attachments.length >= ATTACHMENT_COMPOSE_LIMITS.maxCount) {
			return { outcome: 'tooMany' };
		}
		const size = await storedFileSize(ctx, args.storageId);
		if (size > MAX_ATTACHMENT_BYTES) return { outcome: 'tooLarge' };
		const existing = await Promise.all(
			draft.attachments.map((attachment) => storedFileSize(ctx, attachment.storageId))
		);
		if (
			existing.reduce((total, bytes) => total + bytes, size) >
			ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes
		) {
			return { outcome: 'totalTooLarge' };
		}
		// The staged receipt binds to the draft like an upload, so discard and
		// send free it.
		const session = await getMutationContext(ctx);
		await consumeUpload(ctx, args.storageId, session, `mailDrafts:${args.draftId}`);
		await ctx.db.patch(args.draftId, {
			attachments: [
				...draft.attachments,
				{
					storageId: args.storageId,
					filename: entry.filename,
					contentType: entry.contentType,
					size,
					isInline: false,
				},
			],
			expectedAttachments: entries.map((e) =>
				e.key === args.key ? settled(e, 'attached', args.storageId) : e
			),
			lastEditedAt: Date.now(),
		});
		return { outcome: 'bound' };
	},
});

/**
 * The person takes an owed (or already attached) file out. Settles the key as
 * removed, so a copy still in flight is refused, and removes a copy that
 * already landed. A forward's key covers the whole forward: removed before it
 * was expanded, expansion then finds nothing to do; removed after (another tab
 * expanded it meanwhile), every part it expanded into is settled as removed,
 * and the copies that landed are taken out with their blobs.
 */
export const remove = postboxMutation({
	args: { draftId: v.id('mailDrafts'), key: v.string() },
	handler: async (ctx, args) => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		const entries = draft.expectedAttachments ?? [];
		const covered = (key: string) =>
			key === args.key || (args.key.startsWith('forward:') && key.startsWith(`${args.key}:`));
		const taken = entries.filter((e) => covered(e.key) && e.state !== 'removed');
		if (taken.length === 0) return { ok: true };
		const landed = new Set(taken.flatMap((e) => (e.storageId ? [e.storageId] : [])));
		const removing = draft.attachments.filter((a) => landed.has(a.storageId));
		await ctx.db.patch(args.draftId, {
			attachments: draft.attachments.filter((a) => !landed.has(a.storageId)),
			expectedAttachments: entries.map((e) =>
				covered(e.key) && e.state !== 'removed' ? settled(e, 'removed') : e
			),
			lastEditedAt: Date.now(),
		});
		for (const attachment of removing) {
			await deleteOwnedUpload(ctx, attachment.storageId, `mailDrafts:${args.draftId}`);
		}
		return { ok: true };
	},
});
