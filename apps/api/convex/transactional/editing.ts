/**
 * The writes behind the transactional email editor: the editable-field update,
 * publish and unpublish. The dashboard mutations in `emails.ts` and the public
 * API (`publicApi/transactionalEmails.ts`) both call these, so an email written
 * either way is checked, sanitised, rendered, scanned and audited alike. Each
 * caller does its own authorisation first and passes the actor the audit log
 * names.
 */

import { isValidSlug } from '@owlat/shared';
import {
	dataVariableExamplesFault,
	examplesForSchema,
	type DataVariableExamples,
} from '@owlat/shared/dataVariableExamples';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
	throwAlreadyExists,
	throwInvalidInput,
	throwInvalidState,
	throwNotFound,
} from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { assertContentRevision } from '../lib/contentRevision';
import {
	assertEditableForPublishableChange,
	buildEditablePatch,
	publishedRender,
	type EditableEmailArgs,
	type EditableEmailPatch,
} from '../lib/publishableEmail';
import { loadEmailTheme } from '../lib/publishableEmailRender';
import { scanPublishedEdit } from './lifecycle';

/** What an update may change on a transactional email. */
export interface TransactionalEmailEdit extends EditableEmailArgs {
	slug?: string;
	dataVariablesSchema?: Doc<'transactionalEmails'>['dataVariablesSchema'];
	/**
	 * Every variable's example, replacing the stored ones. Left out, each stored
	 * example stays while it still matches its variable's type.
	 */
	dataVariableExamples?: Doc<'transactionalEmails'>['dataVariableExamples'];
	showUnsubscribe?: boolean;
	attachments?: string;
	/** Allow editing publishable content on a `published` row. */
	forceWhilePublished?: boolean;
	/** Refuse the write with `conflict` when the row's revision moved on. */
	expectedContentRevision?: number;
}

/**
 * The examples to store beside `schema`. Given ones replace the stored ones
 * and are refused, naming the variable, when one does not fit; left out, each
 * stored one is kept while it still matches its variable's type. `undefined`
 * when none are left, so the field is cleared.
 */
export function examplesToStore(
	schema: Doc<'transactionalEmails'>['dataVariablesSchema'],
	given: Readonly<Record<string, unknown>> | undefined,
	stored: Doc<'transactionalEmails'>['dataVariableExamples']
): DataVariableExamples | undefined {
	if (given === undefined) {
		const kept = examplesForSchema(schema, stored);
		return Object.keys(kept).length > 0 ? kept : undefined;
	}
	const fault = dataVariableExamplesFault(schema, given);
	if (fault) {
		throwInvalidInput(fault.message, {
			reason: 'invalid_example',
			field: fault.variable ? `dataVariableExamples.${fault.variable}` : 'dataVariableExamples',
		});
	}
	return Object.keys(given).length > 0 ? (given as DataVariableExamples) : undefined;
}

/**
 * Apply an edit to a transactional email: the publish guard, the revision
 * guard, the slug check, the editable patch (sanitised and rendered on the
 * server), the content scan a published email gets, and the audit row.
 * Returns the patch it stored.
 */
export async function applyTransactionalEmailEdit(
	ctx: MutationCtx,
	email: Doc<'transactionalEmails'>,
	args: TransactionalEmailEdit,
	actorUserId: string
): Promise<EditableEmailPatch> {
	assertEditableForPublishableChange(email, 'Transactional email', args.forceWhilePublished);
	assertContentRevision(email, args.expectedContentRevision);

	if (args.slug && args.slug !== email.slug) {
		const existing = await ctx.db
			.query('transactionalEmails')
			.withIndex('by_slug', (q) => q.eq('slug', args.slug!))
			.first();

		if (existing) {
			throwAlreadyExists(`A transactional email with slug "${args.slug}" already exists`);
		}

		if (!isValidSlug(args.slug)) {
			throwInvalidInput(
				"Slug must be lowercase alphanumeric with hyphens (e.g., 'welcome-email', 'order-confirmation')"
			);
		}
	}

	const updates = {
		...(await buildEditablePatch(ctx, email, args, {
			noun: 'Transactional email',
			variableType: 'data',
			searchableFields: ['name', 'subject', 'slug'],
		})),
		...(args.slug !== undefined && { slug: args.slug }),
		...(args.dataVariablesSchema !== undefined && {
			dataVariablesSchema: args.dataVariablesSchema,
		}),
		...((args.dataVariablesSchema !== undefined || args.dataVariableExamples !== undefined) && {
			dataVariableExamples: examplesToStore(
				args.dataVariablesSchema ?? email.dataVariablesSchema,
				args.dataVariableExamples,
				email.dataVariableExamples
			),
		}),
		...(args.showUnsubscribe !== undefined && { showUnsubscribe: args.showUnsubscribe }),
		...(args.attachments !== undefined && { attachments: args.attachments }),
	};

	await ctx.db.patch(email._id, updates);
	await scanPublishedEdit(ctx, email._id, actorUserId);

	const changedFields = Object.keys(updates).filter(
		(k) => k !== 'updatedAt' && k !== 'contentRevision'
	);
	await recordAuditLog(ctx, {
		userId: actorUserId,
		action: 'transactional_email.updated',
		resource: 'transactional_email',
		resourceId: email._id,
		details: { changedFields: changedFields.join(', ') },
	});
	return updates;
}

/**
 * Publish a transactional email: render its HTML from the stored blocks and
 * hand it to the lifecycle, whose content scan publishes it, holds it for
 * review, or refuses it.
 */
export async function publishTransactionalEmail(
	ctx: MutationCtx,
	email: Doc<'transactionalEmails'>,
	actorUserId: string,
	expectedContentRevision?: number
): Promise<void> {
	if (email.status === 'published') {
		throwInvalidState('Transactional email is already published');
	}
	assertContentRevision(email, expectedContentRevision, 'publish');
	const { html, plainTextContent } = publishedRender(email, {
		variableType: 'data',
		theme: await loadEmailTheme(ctx),
	});
	// The text body goes live with the HTML it was rendered beside.
	if (plainTextContent !== undefined) await ctx.db.patch(email._id, { plainTextContent });

	const outcome = await ctx.runMutation(internal.transactional.lifecycle.transition, {
		emailId: email._id,
		input: { to: 'published', at: Date.now(), ...html },
		userId: actorUserId,
	});

	if (!outcome.ok) {
		if (outcome.reason === 'email_not_found') {
			throwNotFound('Transactional email');
		}
		throwInvalidState(`Cannot publish transactional email: ${outcome.reason}`);
	}
}

/** Return a transactional email to draft. */
export async function unpublishTransactionalEmail(
	ctx: MutationCtx,
	emailId: Id<'transactionalEmails'>,
	actorUserId: string
): Promise<void> {
	const outcome = await ctx.runMutation(internal.transactional.lifecycle.transition, {
		emailId,
		input: { to: 'draft', at: Date.now() },
		userId: actorUserId,
	});

	if (!outcome.ok) {
		if (outcome.reason === 'email_not_found') {
			throwNotFound('Transactional email');
		}
		throwInvalidState(`Cannot unpublish transactional email: ${outcome.reason}`);
	}
}
