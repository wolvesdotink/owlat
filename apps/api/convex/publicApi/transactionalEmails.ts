/**
 * What the `/api/v1/transactional-emails` routes read and write
 * (`transactionalEmailsHttp.ts`), in the public contract's shape.
 *
 * Every write goes through the editor's own path (`transactional/editing.ts`,
 * `transactional/lifecycle.ts`): the blocks are sanitised and rendered on the
 * server, a published email is scanned, and the audit log names the API key
 * as the actor the way contact writes through a key do. The `transactional`
 * feature flag gates these as it gates the dashboard pages.
 *
 * Each write is one mutation that also spends the key's template-write token,
 * so a refused write costs nothing and a request commits once.
 */

import { v, type Infer } from 'convex/values';
import type { TransactionalEmail, TransactionalEmailSummary } from '@owlat/public-contract';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import {
	throwAlreadyExists,
	throwConflict,
	throwForbidden,
	throwInternal,
	throwInvalidInput,
	throwInvalidState,
	throwNotFound,
} from '../_utils/errors';
import { featureDisabledMessage, isFeatureEnabled } from '../lib/featureFlags';
import {
	dataVariableExamplesValidator,
	dataVariablesSchemaValidator,
} from '../lib/convexValidators';
import { currentContentRevision } from '../lib/contentRevision';
import { decodeStoredTranslations } from '../lib/emailJson';
import { paginateClientCursor } from '../lib/pagination';
import { rateLimiter } from '../lib/rateLimiter';
import { parseContentBlocks } from '../emailBlocks/consumers';
import { linkedBlockIdsOf } from '../emailCoediting/target';
import { insertTransactionalEmail } from '../transactional/lifecycle';
import {
	applyTransactionalEmailEdit,
	publishTransactionalEmail,
	unpublishTransactionalEmail,
} from '../transactional/editing';

/** The audit actor of a write made through an API key, as contact writes name it. */
export const API_KEY_ACTOR = 'api';

const DEFAULT_LANGUAGE = 'en';

const iso = (ms: number) => new Date(ms).toISOString();

function toSummary(row: Doc<'transactionalEmails'>): TransactionalEmailSummary {
	const defaultLanguage = row.defaultLanguage ?? DEFAULT_LANGUAGE;
	const others = (row.supportedLanguages ?? []).filter((lang) => lang !== defaultLanguage);
	return {
		id: row._id,
		slug: row.slug,
		name: row.name,
		status: row.status,
		subject: row.subject,
		defaultLanguage,
		languages: [defaultLanguage, ...others],
		revision: currentContentRevision(row),
		publishedAt: row.publishedAt === undefined ? null : iso(row.publishedAt),
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	};
}

/** A stored row in the contract's shape. */
export function toTransactionalEmail(row: Doc<'transactionalEmails'>): TransactionalEmail {
	const decoded = row.translations ? decodeStoredTranslations(row.translations) : null;
	const translations: TransactionalEmail['translations'] = {};
	if (decoded?.ok) {
		for (const [language, overlay] of Object.entries(decoded.value)) {
			translations[language] = { subject: overlay.subject ?? null, blocks: overlay.blocks ?? {} };
		}
	}
	return {
		...toSummary(row),
		blocks: parseContentBlocks(row.content) as TransactionalEmail['blocks'],
		translations,
		dataVariablesSchema: { ...row.dataVariablesSchema },
		dataVariableExamples: { ...row.dataVariableExamples },
		showUnsubscribe: row.showUnsubscribe === true,
	};
}

/**
 * The dashboard's floor for transactional emails, with the refusal reason the
 * API's other transactional routes answer with.
 */
async function assertTransactionalEnabled(ctx: QueryCtx | MutationCtx): Promise<void> {
	if (await isFeatureEnabled(ctx, 'transactional')) return;
	throwForbidden(featureDisabledMessage('transactional'), {
		reason: 'feature_disabled',
		feature: 'transactional',
	});
}

async function findBySlug(
	ctx: { db: QueryCtx['db'] },
	slug: string
): Promise<Doc<'transactionalEmails'> | null> {
	return await ctx.db
		.query('transactionalEmails')
		.withIndex('by_slug', (q) => q.eq('slug', slug))
		.first();
}

async function findOrThrow(
	ctx: { db: QueryCtx['db'] },
	slug: string
): Promise<Doc<'transactionalEmails'>> {
	const email = await findBySlug(ctx, slug);
	if (!email) throwNotFound('Transactional email');
	return email;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export const listForApi = internalQuery({
	args: { limit: v.number(), cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, args) => {
		await assertTransactionalEnabled(ctx);
		const page = await paginateClientCursor(ctx.db.query('transactionalEmails').order('asc'), {
			numItems: args.limit,
			cursor: args.cursor,
		});
		return {
			data: page.page.map(toSummary),
			pagination: {
				limit: args.limit,
				cursor: page.isDone ? null : page.continueCursor,
				isDone: page.isDone,
			},
		};
	},
});

export const getForApi = internalQuery({
	args: { slug: v.string() },
	handler: async (ctx, args): Promise<TransactionalEmail | null> => {
		await assertTransactionalEnabled(ctx);
		const email = await findBySlug(ctx, args.slug);
		return email ? toTransactionalEmail(email) : null;
	},
});

// ─── Writes ─────────────────────────────────────────────────────────────────

/** The editable fields of a write, already checked and serialised by the route. */
const editableFields = {
	name: v.string(),
	subject: v.string(),
	/** The sanitised blocks the content check returned, as stored JSON. */
	content: v.string(),
	/** The translation overlays as stored JSON. */
	translations: v.string(),
	defaultLanguage: v.string(),
	dataVariablesSchema: dataVariablesSchemaValidator,
	/** Left out, each stored example stays while it still matches its variable's type. */
	dataVariableExamples: v.optional(dataVariableExamplesValidator),
	showUnsubscribe: v.boolean(),
};

const editableFieldsValidator = v.object(editableFields);

type EditableFields = Infer<typeof editableFieldsValidator>;

type WriteOutcome =
	| { ok: true; email: TransactionalEmail; created: boolean }
	| { ok: false; reason: 'rate_limited'; retryAfterSeconds: number };

type TransitionOutcome =
	| { ok: true; email: TransactionalEmail }
	| { ok: false; reason: 'rate_limited'; retryAfterSeconds: number };

/** Spend one of the key's template-write tokens, or say how long to wait. */
async function spendWriteToken(
	ctx: MutationCtx,
	keyId: Id<'apiKeys'>
): Promise<{ ok: true } | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number }> {
	const { ok, retryAfter } = await rateLimiter.limit(ctx, 'apiTemplateWrite', { key: keyId });
	if (ok) return { ok: true };
	return {
		ok: false,
		reason: 'rate_limited',
		retryAfterSeconds: Math.ceil((retryAfter ?? 1000) / 1000),
	};
}

/**
 * The saved blocks the content links, each checked to exist. A link to a
 * block this instance does not have is refused: the email would never follow
 * the block's changes, and the editor could not show it as linked.
 */
async function linkedSavedBlocks(ctx: MutationCtx, content: string): Promise<string[]> {
	const blocks = parseContentBlocks(content);
	const ids = linkedBlockIdsOf(blocks as unknown as Parameters<typeof linkedBlockIdsOf>[0]);
	for (const id of ids) {
		const blockId = ctx.db.normalizeId('emailBlocks', id);
		if (!blockId || !(await ctx.db.get(blockId))) {
			const holder = blocks.find(
				(block) => (block.savedBlockRef as { blockId?: unknown } | undefined)?.blockId === id
			);
			throwInvalidInput(`The saved block "${id}" a block links to does not exist`, {
				reason: 'invalid_content',
				field: 'blocks',
				...(holder ? { blockId: holder.id } : {}),
			});
		}
	}
	return ids;
}

function supportedLanguagesOf(fields: EditableFields): string[] {
	const decoded = decodeStoredTranslations(fields.translations);
	const others = decoded.ok
		? Object.keys(decoded.value).filter((lang) => lang !== fields.defaultLanguage)
		: [];
	return [fields.defaultLanguage, ...others];
}

/** Write every editable field of `email` through the editor's update path. */
async function replaceEditableFields(
	ctx: MutationCtx,
	email: Doc<'transactionalEmails'>,
	fields: EditableFields,
	forceWhilePublished: boolean
): Promise<void> {
	await applyTransactionalEmailEdit(
		ctx,
		email,
		{
			name: fields.name,
			subject: fields.subject,
			content: fields.content,
			translations: fields.translations,
			supportedLanguages: supportedLanguagesOf(fields),
			defaultLanguage: fields.defaultLanguage,
			dataVariablesSchema: fields.dataVariablesSchema,
			...(fields.dataVariableExamples !== undefined && {
				dataVariableExamples: fields.dataVariableExamples,
			}),
			showUnsubscribe: fields.showUnsubscribe,
			linkedBlockIds: await linkedSavedBlocks(ctx, fields.content),
			forceWhilePublished,
		},
		API_KEY_ACTOR
	);
}

/** Insert a draft under `slug` and give it every editable field. */
async function createEmail(
	ctx: MutationCtx,
	slug: string,
	fields: EditableFields
): Promise<Doc<'transactionalEmails'>> {
	const outcome = await insertTransactionalEmail(ctx, {
		name: fields.name,
		slug,
		subject: fields.subject,
		content: '[]',
		defaultLanguage: fields.defaultLanguage,
		userId: API_KEY_ACTOR,
	});
	if (!outcome.ok) {
		if (outcome.reason === 'invalid_slug_format') {
			throwInvalidInput('slug must hold only lowercase letters, digits and hyphens', {
				field: 'slug',
			});
		}
		throwAlreadyExists(`A transactional email with slug "${slug}" already exists`, {
			reason: 'slug_taken',
			field: 'slug',
		});
	}
	const inserted = await ctx.db.get(outcome.emailId);
	if (!inserted) throwInternal('The created email was not found');
	await replaceEditableFields(ctx, inserted, fields, false);
	return inserted;
}

async function reread(ctx: MutationCtx, emailId: Id<'transactionalEmails'>) {
	const row = await ctx.db.get(emailId);
	if (!row) throwInternal('The written email was not found');
	return toTransactionalEmail(row);
}

function assertRevision(email: Doc<'transactionalEmails'>, expected: number | undefined): void {
	if (expected === undefined) return;
	const current = currentContentRevision(email);
	if (current === expected) return;
	throwConflict(
		`The email is at revision ${current}, not ${expected}: it changed after you read it. Read it again and reapply your change.`,
		{ reason: 'revision_mismatch', currentRevision: current }
	);
}

export const createForApi = internalMutation({
	args: { keyId: v.id('apiKeys'), slug: v.string(), fields: editableFieldsValidator },
	handler: async (ctx, args): Promise<WriteOutcome> => {
		const token = await spendWriteToken(ctx, args.keyId);
		if (!token.ok) return token;
		await assertTransactionalEnabled(ctx);
		const created = await createEmail(ctx, args.slug, args.fields);
		return { ok: true, email: await reread(ctx, created._id), created: true };
	},
});

export const putForApi = internalMutation({
	args: {
		keyId: v.id('apiKeys'),
		slug: v.string(),
		fields: editableFieldsValidator,
		expectedRevision: v.optional(v.number()),
		whilePublished: v.boolean(),
	},
	handler: async (ctx, args): Promise<WriteOutcome> => {
		const token = await spendWriteToken(ctx, args.keyId);
		if (!token.ok) return token;
		await assertTransactionalEnabled(ctx);

		const email = await findBySlug(ctx, args.slug);
		if (!email) {
			if (args.expectedRevision !== undefined) {
				throwConflict('No transactional email has this slug, so If-Match cannot match.', {
					reason: 'revision_mismatch',
					currentRevision: null,
				});
			}
			const created = await createEmail(ctx, args.slug, args.fields);
			return { ok: true, email: await reread(ctx, created._id), created: true };
		}

		assertRevision(email, args.expectedRevision);
		if (email.status === 'published' && !args.whilePublished) {
			throwInvalidState(
				'The email is published. Send whilePublished=true to change it while it is live, or unpublish it first.',
				{ reason: 'email_published' }
			);
		}
		const relabels = args.fields.defaultLanguage !== (email.defaultLanguage ?? DEFAULT_LANGUAGE);
		if (relabels && supportedLanguagesOf(args.fields).length > 1) {
			throwInvalidState(
				'The default language cannot change while the email has translations: the blocks would stay in the old language.',
				{ reason: 'default_language_change', field: 'defaultLanguage' }
			);
		}
		await replaceEditableFields(ctx, email, args.fields, args.whilePublished);
		return { ok: true, email: await reread(ctx, email._id), created: false };
	},
});

export const publishForApi = internalMutation({
	args: {
		keyId: v.id('apiKeys'),
		slug: v.string(),
		expectedRevision: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const token = await spendWriteToken(ctx, args.keyId);
		if (!token.ok) return token;
		await assertTransactionalEnabled(ctx);
		const email = await findOrThrow(ctx, args.slug);
		assertRevision(email, args.expectedRevision);
		// Publishing a live email is a no-op, so a script can publish
		// unconditionally after every import. An email the content scan held
		// for review stays held: only an admin's approval publishes it, as in
		// the editor, which offers no publish while it waits.
		if (email.status === 'draft') {
			await publishTransactionalEmail(ctx, email, API_KEY_ACTOR);
		}
		return { ok: true, email: await reread(ctx, email._id) };
	},
});

export const unpublishForApi = internalMutation({
	args: { keyId: v.id('apiKeys'), slug: v.string() },
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const token = await spendWriteToken(ctx, args.keyId);
		if (!token.ok) return token;
		await assertTransactionalEnabled(ctx);
		const email = await findOrThrow(ctx, args.slug);
		if (email.status === 'pending_review') {
			// The editor offers no way out of review but an admin's decision.
			throwInvalidState('The email is waiting for an admin to review it.', {
				reason: 'email_in_review',
			});
		}
		if (email.status === 'published') {
			await unpublishTransactionalEmail(ctx, email._id, API_KEY_ACTOR);
		}
		return { ok: true, email: await reread(ctx, email._id) };
	},
});
