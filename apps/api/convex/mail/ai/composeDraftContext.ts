/**
 * The V8 half of Answer mode "Draft with AI" context: what the Node action
 * (mail/ai/composeDraft.ts) reads before it checks for gaps and drafts, and the
 * upload check and Files copy a file answer needs.
 *
 * Both loaders run with the caller's identity and re-check access: a Postbox
 * draft needs its mailbox, a team thread needs the shared-inbox reader role
 * (inbox/access.ts), the same gates the reader and the thread view use.
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import type { Doc, Id } from '../../_generated/dataModel';
import { normalizeEmail } from '@owlat/shared';
import { htmlToPlainText } from '@owlat/shared/html';
import { requireMailboxAccess } from '../permissions';
import { assertStateIs } from '../draftLifecycle/reducers';
import { withStoredInlineBodies } from '../../lib/messageBodyStore';
import { openInboundMessageBody } from '../../lib/messageBodyInbound';
import { requireOrgMember } from '../../lib/sessionOrganization';
import { isSharedInboxReader } from '../../inbox/access';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { findContactByIdentifier } from '../../contacts/resolution';
import {
	assertOwnUnclaimedUpload,
	canSaveAnswerToFiles,
	saveAnswerFileToFiles,
} from '../../lib/answerFileToFiles';
import { asEagernessMode, type EagernessMode } from '../../inbox/askEagerness';
import { throwForbidden, throwNotFound } from '../../_utils/errors';
import type { MailboxAttachmentScope } from '../../lib/validators/answerAsk';
import { buildThreadTranscript, ANSWER_DRAFT } from './transcript';

/** Messages of a Postbox thread the draft sees (newest kept when trimming). */
const ANSWER_CONTEXT_MESSAGES = 8;
/** Characters of the message being answered that the file-request check reads. */
const TRIGGER_TEXT_CHARS = 4000;

/** The contact a reply goes to, as the drafter needs it. */
interface AnswerContact {
	contactId: Id<'contacts'>;
	name?: string;
	language?: string;
}

async function readEagerness(ctx: Pick<QueryCtx, 'db'>): Promise<EagernessMode | undefined> {
	const row = await ctx.db.query('askEagernessSettings').first();
	return asEagernessMode(row?.mode);
}

function contactView(contact: Doc<'contacts'>): AnswerContact {
	const name = [contact.firstName, contact.lastName]
		.filter((part): part is string => !!part && part.trim().length > 0)
		.join(' ');
	return {
		contactId: contact._id,
		...(name ? { name } : {}),
		...(contact.language ? { language: contact.language } : {}),
	};
}

/**
 * Everything a Postbox draft's "Draft with AI" needs: the side-labelled thread
 * transcript with each message's attachment names, the message being answered
 * (for the file-request check), the other party and their contact, and the
 * ask-eagerness dial.
 */
export const loadMailDraftContext = internalQuery({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args) => {
		const session = await requireOrgMember(ctx);
		const draft = await ctx.db.get(args.draftId);
		if (!draft) throwNotFound('Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId, 'member', session);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		const mailbox = owned.mailbox;

		const replied = draft.inReplyToMessageId ? await ctx.db.get(draft.inReplyToMessageId) : null;
		const trigger = replied && replied.mailboxId === draft.mailboxId ? replied : null;
		const threadId = draft.threadId ?? trigger?.threadId;
		let messages: Doc<'mailMessages'>[] = trigger ? [trigger] : [];
		if (threadId) {
			const newest = await ctx.db
				.query('mailMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.order('desc')
				.take(ANSWER_CONTEXT_MESSAGES);
			messages = newest
				.filter((m) => m.mailboxId === draft.mailboxId)
				.filter((m) => !trigger || m.receivedAt <= trigger.receivedAt)
				.sort((a, b) => a.receivedAt - b.receivedAt);
			if (trigger && !messages.some((m) => m._id === trigger._id)) messages.push(trigger);
		}
		const withBodies = await withStoredInlineBodies(ctx.db, messages);
		const transcript = await buildThreadTranscript(withBodies, {
			...ANSWER_DRAFT,
			ownerAddress: mailbox.address,
			...(trigger ? { triggerId: trigger._id } : {}),
			includeAttachments: true,
		});
		const triggerRow = trigger ? withBodies.find((m) => m._id === trigger._id) : undefined;
		const triggerText = triggerRow
			? await buildThreadTranscript([triggerRow], {
					perMessageChars: TRIGGER_TEXT_CHARS,
					totalChars: TRIGGER_TEXT_CHARS,
				})
			: '';

		const counterpartAddress = trigger
			? (trigger.replyToAddress ?? trigger.fromAddress)
			: draft.toAddresses[0];
		const identifier = counterpartAddress ? normalizeEmail(counterpartAddress) : '';
		const found = identifier ? await findContactByIdentifier(ctx, 'email', identifier) : null;

		// The automatic file search may look at this thread and at mail from or
		// to the person answered, never at the rest of the mailbox.
		const counterparts = trigger
			? [trigger.fromAddress, ...(trigger.replyToAddress ? [trigger.replyToAddress] : [])]
			: draft.toAddresses.slice(0, 1);
		const mailboxScope: MailboxAttachmentScope = {
			mailboxId: draft.mailboxId,
			...(threadId ? { threadId } : {}),
			counterparts: counterparts.map((address) => normalizeEmail(address)).filter(Boolean),
		};

		return {
			mailboxId: draft.mailboxId,
			mailboxScope,
			ownerAddress: mailbox.address,
			subject: trigger?.subject ?? draft.subject,
			transcript,
			triggerText,
			...(counterpartAddress ? { counterpartAddress } : {}),
			...(found ? { contact: contactView(found.contact) } : {}),
			eagerness: await readEagerness(ctx),
		};
	},
});

/**
 * Everything a team thread's "Draft with AI" needs from the database: the
 * newest inbound message (the action builds the pipeline's own briefing from
 * it), its sender and contact, and the ask-eagerness dial.
 */
export const loadTeamThreadContext = internalQuery({
	args: { threadId: v.id('conversationThreads') },
	handler: async (ctx, args) => {
		const session = await requireOrgMember(ctx);
		if (!isSharedInboxReader(session)) throwForbidden('Only inbox readers can draft here');
		if (!(await isFeatureEnabled(ctx, 'inbox'))) throwForbidden('The team inbox is turned off');
		const thread = await ctx.db.get(args.threadId);
		if (!thread) throwNotFound('Conversation');
		const latest = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('desc')
			.first();
		if (!latest) throwNotFound('Message');
		// A query cannot read blobs: a body too large for its row gives its
		// excerpt, which is longer than the trigger text keeps anyway.
		const body = await openInboundMessageBody(latest, null);
		const text = body.text?.trim()
			? body.text
			: body.html
				? htmlToPlainText(body.html)
				: (body.excerpt ?? '');
		const contactId = latest.contactId ?? thread.contactId;
		const contact = contactId ? await ctx.db.get(contactId) : null;
		return {
			inboundMessageId: latest._id,
			subject: latest.subject,
			triggerText: `From: ${latest.from}\nSubject: ${latest.subject}\n${text}`.slice(
				0,
				TRIGGER_TEXT_CHARS
			),
			counterpartAddress: latest.from,
			...(contact && contact.deletedAt === undefined ? { contact: contactView(contact) } : {}),
			eagerness: await readEagerness(ctx),
		};
	},
});

/**
 * A fresh upload given as a file answer: only the caller's own, still
 * unclaimed upload qualifies (the same rule `consumeUpload` enforces when the
 * draft or the team inbox binds it). Returns what the attach step needs, and
 * whether the caller may keep a copy in Files (lib/answerFileToFiles.ts).
 */
export const ownUploadInfo = internalQuery({
	args: { storageId: v.id('_storage') },
	handler: async (
		ctx,
		args
	): Promise<{ contentType: string; size: number; canSaveToFiles: boolean }> => {
		const session = await requireOrgMember(ctx);
		await assertOwnUnclaimedUpload(ctx, session, args.storageId);
		const meta = await ctx.db.system.get(args.storageId);
		if (!meta) throwNotFound('Upload');
		return {
			contentType: meta.contentType ?? 'application/octet-stream',
			size: meta.size,
			canSaveToFiles: canSaveAnswerToFiles(session),
		};
	},
});

/**
 * Keep a copy of an uploaded file answer in Files, linked to the contact the
 * reply goes to, so the next request for it finds it (plan decision 5). The
 * copy is its own blob, bound to the new row, because the upload itself goes
 * to the reply and is freed with it. The rules (admins only, the Files type
 * policy and size cap, processing) are the shared ones in
 * lib/answerFileToFiles.ts; a refusal throws and the caller drops the copy.
 */
export const keepAnswerFileCopy = internalMutation({
	args: {
		storageId: v.id('_storage'),
		filename: v.string(),
		contentType: v.string(),
		contactId: v.id('contacts'),
	},
	handler: async (ctx, args): Promise<Id<'semanticFiles'>> => {
		const session = await requireOrgMember(ctx);
		const row = await saveAnswerFileToFiles(ctx, session, {
			storageId: args.storageId,
			filename: args.filename,
			mimeType: args.contentType,
			contactId: args.contactId,
			claim: 'copy',
		});
		return row._id;
	},
});
