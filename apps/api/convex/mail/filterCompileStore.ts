/**
 * Read on arrival (SPEC §6.1): the rows behind a plain-language rule. The
 * compile action (`filterCompile.ts`) writes a `mailRuleDrafts` row that goes
 * `compiling` → `ready` (with a preview) or `failed`; the rules section
 * subscribes to the mailbox's recent drafts. Confirming a ready draft saves
 * it as a filter with `origin` and `sourceText`, through the same validator
 * every save boundary uses.
 *
 * Drafts exist for personal mailboxes only: going shared drains them, like
 * every other arrival row.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { postboxMutation, postboxQuery } from './_helpers';
import { isPersonalMailbox, requireMailboxAccess } from './permissions';
import { throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { openMessageBody, sealBodyAtWrite } from '../lib/messageBody';
import { ARRIVAL_RETENTION_MS } from './arrival/changeRows';
import { ruleDraftPreviewValidator } from '../schema/mailArrivalRules';
import { validateFilterForSave } from './filterValidation';

/** Longest rule text the person may type. */
export const MAX_RULE_TEXT_CHARS = 500;

/** Drafts the rules section shows. */
const RECENT_DRAFTS = 5;

/** The folders and labels a compile may name: the mailbox's own, by name. */
export interface CompileTargets {
	folders: { id: Id<'mailFolders'>; name: string }[];
	labels: { id: Id<'mailLabels'>; name: string }[];
}

const MAX_TARGETS = 200;

/**
 * Start a compile: owner-grade access to a personal mailbox, the text sealed
 * into a `compiling` draft. Returns the draft and what the rule may name.
 */
export const startDraft = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		sourceText: v.string(),
		origin: v.union(v.literal('fix'), v.literal('plain_language')),
		fromMessageId: v.optional(v.id('mailMessages')),
	},
	handler: async (ctx, args): Promise<{ draftId: Id<'mailRuleDrafts'> } & CompileTargets> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		if (!isPersonalMailbox(owned.mailbox)) {
			throwInvalidState('Plain-language rules are for personal mailboxes');
		}
		const text = args.sourceText.trim();
		if (!text) throwInvalidInput('Rule text is required');
		if (text.length > MAX_RULE_TEXT_CHARS) throwInvalidInput('Rule text is too long');
		if (args.fromMessageId) {
			const message = await ctx.db.get(args.fromMessageId);
			if (!message || message.mailboxId !== args.mailboxId) throwForbidden('Message not found');
		}
		const now = Date.now();
		const draftId = await ctx.db.insert('mailRuleDrafts', {
			mailboxId: args.mailboxId,
			sourceText: await sealBodyAtWrite(text),
			status: 'compiling',
			origin: args.origin,
			...(args.fromMessageId ? { fromMessageId: args.fromMessageId } : {}),
			createdAt: now,
			expiresAt: now + ARRIVAL_RETENTION_MS.ruleDraft,
		});
		const folders = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.take(MAX_TARGETS);
		const labels = await ctx.db
			.query('mailLabels')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.take(MAX_TARGETS);
		return {
			draftId,
			folders: folders.map((folder) => ({ id: folder._id, name: folder.name })),
			labels: labels.map((label) => ({ id: label._id, name: label.name })),
		};
	},
});

type Preview = NonNullable<Doc<'mailRuleDrafts'>['preview']>;

async function checkPreview(
	ctx: MutationCtx,
	draft: Doc<'mailRuleDrafts'>,
	preview: Preview
): Promise<void> {
	await validateFilterForSave(ctx, draft.mailboxId, {
		origin: draft.origin,
		aiCondition: preview.aiCondition,
		conditions: preview.conditions,
		actions: preview.actions,
		stopProcessing: false,
	});
}

/** Land a compile: `ready` with a preview that passes the validator, else `failed`. */
export const finishDraft = internalMutation({
	args: { draftId: v.id('mailRuleDrafts'), preview: v.optional(ruleDraftPreviewValidator) },
	handler: async (ctx, args): Promise<'ready' | 'failed' | 'gone'> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft || draft.status !== 'compiling') return 'gone';
		let status: 'ready' | 'failed' = args.preview ? 'ready' : 'failed';
		if (args.preview) {
			try {
				await checkPreview(ctx, draft, args.preview);
			} catch {
				status = 'failed';
			}
		}
		await ctx.db.patch(draft._id, {
			status,
			...(status === 'ready' && args.preview ? { preview: args.preview } : {}),
		});
		return status;
	},
});

/** The mailbox's recent drafts, newest first, with their text. */
export const recentDrafts = postboxQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) return [];
		const drafts = await ctx.db
			.query('mailRuleDrafts')
			.withIndex('by_mailbox_created', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(RECENT_DRAFTS);
		const now = Date.now();
		return await Promise.all(
			drafts
				.filter((draft) => draft.expiresAt > now)
				.map(async (draft) => ({
					_id: draft._id,
					status: draft.status,
					origin: draft.origin,
					sourceText: await openMessageBody(draft.sourceText),
					preview: draft.preview,
					createdAt: draft.createdAt,
				}))
		);
	},
});

/**
 * Save a ready draft as a filter (`origin`, `sourceText`, the AI condition at
 * revision 0), at the end of the run order, and drop the draft. `name`
 * overrides the compiled name.
 */
export const confirm = postboxMutation({
	args: { draftId: v.id('mailRuleDrafts'), name: v.optional(v.string()) },
	handler: async (ctx, args): Promise<Id<'mailFilters'>> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) throwInvalidState('This rule draft is gone');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		if (draft.status !== 'ready' || !draft.preview) throwInvalidState('This rule is not ready');
		const preview = draft.preview;
		await checkPreview(ctx, draft, preview);
		const name = (args.name ?? preview.name).trim().slice(0, 120);
		if (!name) throwInvalidInput('Filter name required');
		const existing = await ctx.db
			.query('mailFilters')
			.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', draft.mailboxId))
			.order('desc')
			.first();
		const now = Date.now();
		const filterId = await ctx.db.insert('mailFilters', {
			mailboxId: draft.mailboxId,
			name,
			isEnabled: true,
			priority: (existing?.priority ?? 0) + 100,
			conditions: preview.conditions,
			actions: preview.actions,
			...(preview.matchType === 'any' ? { matchType: 'any' as const } : {}),
			stopProcessing: false,
			origin: draft.origin,
			sourceText: draft.sourceText,
			...(preview.aiCondition
				? { aiCondition: { question: preview.aiCondition.question, revision: 0 } }
				: {}),
			revision: 0,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.delete(draft._id);
		return filterId;
	},
});

/** Drop a draft the person does not want. */
export const discard = postboxMutation({
	args: { draftId: v.id('mailRuleDrafts') },
	handler: async (ctx, args): Promise<void> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) return;
		const owned = await requireMailboxAccess(ctx, draft.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		await ctx.db.delete(draft._id);
	},
});
