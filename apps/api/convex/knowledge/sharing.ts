/**
 * Sharing a restricted knowledge entry with members again (#1372).
 *
 * Migration 0069 made every entry that existed before it owner/admin-only
 * (`memberAccess: 'restricted'`), because a historical dedup merge may have
 * folded private text, tags or contact links into any of them and nothing
 * recorded which. This module is the one way back, per entry: an owner or
 * admin reviews the entry's complete content, tags and contact links, and
 * confirms. Nothing else writes `memberAccess: 'members'` onto an existing
 * entry (`knowledge.graph.updateEntry` cannot).
 *
 * WHAT CAN NEVER BE SHARED. The review is for the merge question only; it does
 * not override where an entry came from. {@link shareBlocker} refuses, whatever
 * the reviewer says, an entry whose source still keeps it from members, the
 * same rule a new write of that source follows (knowledge/entryDedupe.ts
 * `resolveMemberAccess`):
 *   - Team Inbox knowledge: `sourceType: 'agent_extracted'`, a source id that
 *     is a Team Inbox message, or a Team Inbox thread link (`threadId`);
 *   - knowledge from a file captured from inbound mail, which keeps its
 *     mailbox's permission for good (lib/semanticFileAccess.ts);
 *   - knowledge whose source file is gone, or a file entry whose source is not
 *     recorded: nothing proves it was an upload, so it fails closed;
 *   - a curated answer whose earlier source is not recorded and whose
 *     `sourceId` does not name a file to check: it may have been made from
 *     any of the above, so it fails closed too.
 * Turning an entry into a curated answer (`knowledge.graph.createPolicyEntry`)
 * rewrites `sourceType` to `curated`, keeps `sourceId` and `threadId`, and
 * records the earlier source type in `curatedFromSourceType`, so the rule
 * reads the source from those, never from `sourceType` alone. A curated answer
 * written before that field existed has no record. When its `sourceId` names a
 * file, that file decides, as for any entry. Without one, an answer authored
 * as one looks the same as one made from a file entry without a `sourceId`, so
 * both are refused. An owner or admin can still write it again as a new
 * curated answer, which members see.
 *
 * STALE REVIEWS. The review carries a fingerprint of what it showed (title,
 * content, tags, contact links). Sharing refuses when the entry no longer
 * matches it, e.g. a merge or an edit landed while the reviewer was reading.
 *
 * MIGRATION 0069 STILL RUNNING. Its walk restricts every entry created before
 * it started, whatever the entry's current stamp, so sharing such an entry
 * before the walk is done would be undone by it. Those wait until it finishes.
 * Re-running 0069 with `restart` restricts every older entry again, shared
 * ones included; that is the migration's rule.
 *
 * Every share is recorded in the audit log (`knowledge.entry_shared`). A merge
 * never widens access afterwards (knowledge/maintenance.ts
 * `mergedMemberAccess`): folding restricted text into a shared entry restricts
 * it again.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { batchGet } from '../_utils/batchLoader';
import { throwConflict, throwInvalidState, throwNotFound } from '../_utils/errors';
import { isInboxDerivedKnowledge } from '../inbox/access';
import { recordAuditLog } from '../lib/auditLog';
import { sha256Hex } from '../lib/aiRouting/routeDigest';
import { readMigrationRun } from '../lib/migrationLedger';
import { isMailCapture } from '../lib/semanticFileAccess';
import { knowledgeAdminMutation, loadWritableEntry, resolveKnowledgeViewer } from './visibility';

/**
 * The migration that restricted the older entries
 * (migrations/0069_restrict_captured_file_knowledge.ts `MIGRATION`; a test
 * keeps the two equal).
 */
export const RESTRICTION_MIGRATION = '0069_restrict_captured_file_knowledge';

/**
 * Why an entry cannot be shared with members:
 *   - `already_shared`: members can already see it;
 *   - `restriction_pending`: migration 0069 has yet to reach it, or the entry
 *     predates the stamp and the migration has not restricted it yet;
 *   - `team_inbox`: it came from Team Inbox mail or links a Team Inbox thread;
 *   - `mail_capture`: it came from a file captured from inbound mail;
 *   - `source_missing`: its source file is gone or not recorded, or it is a
 *     curated answer whose earlier source is not recorded and that names no
 *     source file.
 */
export type ShareBlocker =
	| 'already_shared'
	| 'restriction_pending'
	| 'team_inbox'
	| 'mail_capture'
	| 'source_missing';

/** The web copy for each refusal (`useBackendOperation` shows it by key). */
const BLOCKER_COPY: Record<ShareBlocker, { message: string; messageKey: string }> = {
	already_shared: {
		message: 'Members can already see this knowledge entry.',
		messageKey: 'components.knowledge.shareWithMembers.blocked.already_shared',
	},
	restriction_pending: {
		message: 'This knowledge entry is still being restricted. Try again when that has finished.',
		messageKey: 'components.knowledge.shareWithMembers.blocked.restriction_pending',
	},
	team_inbox: {
		message: 'Knowledge from the Team Inbox stays with owners and admins.',
		messageKey: 'components.knowledge.shareWithMembers.blocked.team_inbox',
	},
	mail_capture: {
		message: 'Knowledge from a file captured from mail keeps that mailbox’s permission.',
		messageKey: 'components.knowledge.shareWithMembers.blocked.mail_capture',
	},
	source_missing: {
		message: 'The source of this knowledge entry is not known, so it stays with owners and admins.',
		messageKey: 'components.knowledge.shareWithMembers.blocked.source_missing',
	},
};

type ShareFields = Pick<
	Doc<'knowledgeEntries'>,
	| '_creationTime'
	| 'sourceType'
	| 'curatedFromSourceType'
	| 'sourceId'
	| 'threadId'
	| 'memberAccess'
>;

/**
 * Why `entry` cannot be shared with members, or null when it can. See the
 * module doc for the rule; any doubt about the source refuses.
 */
export async function shareBlocker(
	ctx: Pick<QueryCtx, 'db'>,
	entry: ShareFields
): Promise<ShareBlocker | null> {
	if (!isInboxDerivedKnowledge(entry)) return 'already_shared';
	// Unstamped (a file entry written before the stamp existed): migration 0069
	// restricts it first.
	if (entry.memberAccess !== 'restricted') return 'restriction_pending';
	const run = await readMigrationRun(ctx, RESTRICTION_MIGRATION);
	if (run?.status === 'running' && entry._creationTime < run.startedAt) {
		return 'restriction_pending';
	}

	// A curated answer: the source it was made from; undefined when not recorded.
	const source = entry.sourceType === 'curated' ? entry.curatedFromSourceType : entry.sourceType;
	if (entry.threadId !== undefined || source === 'agent_extracted') return 'team_inbox';
	if (entry.sourceId) {
		const fileId = ctx.db.normalizeId('semanticFiles', entry.sourceId);
		if (fileId) {
			const file = await ctx.db.get(fileId);
			if (!file) return 'source_missing';
			return isMailCapture(file) ? 'mail_capture' : null;
		}
		// A curated answer made from Team Inbox knowledge keeps its source message.
		if (ctx.db.normalizeId('inboundMessages', entry.sourceId)) return 'team_inbox';
	}
	if (source === 'file' || source === undefined) return 'source_missing';
	return null;
}

/**
 * A digest of what the review shows, so sharing can tell whether the entry
 * changed after it was reviewed.
 */
export function reviewFingerprint(
	entry: Pick<Doc<'knowledgeEntries'>, 'title' | 'content' | 'tags' | 'contactIds'>
): string {
	return sha256Hex(
		JSON.stringify([entry.title, entry.content, entry.tags ?? [], entry.contactIds ?? []])
	);
}

/**
 * One contact link as the review shows it; name and email are both null when
 * the contact is gone, deleted or soft-deleted.
 */
export interface ShareReviewContact {
	contactId: Id<'contacts'>;
	name: string | null;
	email: string | null;
}

/** What an owner or admin reviews before sharing an entry with members. */
export interface ShareReview {
	entryId: Id<'knowledgeEntries'>;
	title: string;
	content: string;
	tags: string[];
	contacts: ShareReviewContact[];
	/** Why it cannot be shared; null when it can. */
	blocker: ShareBlocker | null;
	/** Passed back to {@link shareWithMembers}. */
	fingerprint: string;
}

/**
 * The review of one entry before sharing it with members: its complete
 * content, tags and contact links (by name), and whether its source allows
 * sharing at all. Owners and admins only; null for anyone else, while
 * `ai.knowledge` is off, or for a missing entry.
 */
export const getShareReview = publicQuery({
	// public: soft-auth — owners and admins only; returns null for anyone else
	args: { entryId: v.id('knowledgeEntries') },
	handler: async (ctx, args): Promise<ShareReview | null> => {
		const viewer = await resolveKnowledgeViewer(ctx);
		if (!viewer?.canShareWithMembers) return null;
		const entry = await ctx.db.get(args.entryId);
		if (!entry) return null;

		const contactIds = [...new Set(entry.contactIds ?? [])];
		const docs = await batchGet(ctx, contactIds);
		const contacts = contactIds.map((contactId): ShareReviewContact => {
			const found = docs.get(contactId);
			// A soft-deleted contact counts as gone (schema/contacts.ts `deletedAt`).
			const contact = found?.deletedAt === undefined ? found : undefined;
			const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim();
			return { contactId, name: name || null, email: contact?.email ?? null };
		});

		return {
			entryId: entry._id,
			title: entry.title,
			content: entry.content,
			tags: entry.tags ?? [],
			contacts,
			blocker: await shareBlocker(ctx, entry),
			fingerprint: reviewFingerprint(entry),
		};
	},
});

/**
 * Share a restricted entry with members, after its review. Refuses an entry
 * whose source keeps it from members ({@link shareBlocker}) and one that
 * changed since the review (`fingerprint`). Records the change in the audit
 * log.
 */
// admin-only: opens owner/admin-only knowledge to every member
export const shareWithMembers = knowledgeAdminMutation({
	args: { entryId: v.id('knowledgeEntries'), fingerprint: v.string() },
	handler: async (ctx, args, session) => {
		const entry = await loadWritableEntry(ctx, session, args.entryId);
		if (!entry) throwNotFound('Knowledge entry');

		const blocker = await shareBlocker(ctx, entry);
		if (blocker) {
			const copy = BLOCKER_COPY[blocker];
			throwInvalidState(copy.message, { reason: blocker, messageKey: copy.messageKey });
		}
		if (reviewFingerprint(entry) !== args.fingerprint) {
			throwConflict('This knowledge entry changed after you reviewed it. Review it again.', {
				messageKey: 'components.knowledge.shareWithMembers.changed',
			});
		}

		await ctx.db.patch(entry._id, { memberAccess: 'members' });
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'knowledge.entry_shared',
			resource: 'knowledge_entry',
			resourceId: entry._id,
			details: { from: 'restricted', to: 'members', sourceType: entry.sourceType },
		});
		return entry._id;
	},
});
