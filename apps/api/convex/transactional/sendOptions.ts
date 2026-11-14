/**
 * A transactional template's send options that change what the send API
 * accepts, not what the email says: which variables a caller may leave out,
 * and whether the template is held to the per-recipient cap.
 *
 * Neither touches the content, so both apply to a published template straight
 * away, without a forced edit or a new content scan.
 */

import { v } from 'convex/values';
import { transactionalMutation } from './_helpers';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { getOrThrow, throwInvalidInput } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';

const VARIABLE_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Mark one data variable optional or required. An optional variable may be
 * left out of a send request and renders empty, or as its fallback; a variable
 * that is not optional and has no fallback must be supplied.
 */
export const setVariableOptional = transactionalMutation({
	args: {
		id: v.id('transactionalEmails'),
		key: v.string(),
		isOptional: v.boolean(),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'templates:manage'),
			'Only owners and admins can change which variables a transactional email requires'
		);
		if (!VARIABLE_KEY.test(args.key)) {
			throwInvalidInput(
				`Invalid variable name "${args.key}". Must start with a letter and contain only letters, numbers, and underscores.`
			);
		}
		const email = await getOrThrow(ctx, args.id, 'Transactional email');
		const rest = (email.optionalDataVariables ?? []).filter((key) => key !== args.key);
		const optionalDataVariables = args.isOptional ? [...rest, args.key] : rest;
		await ctx.db.patch(args.id, {
			optionalDataVariables: optionalDataVariables.length > 0 ? optionalDataVariables : undefined,
			updatedAt: Date.now(),
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'transactional_email.updated',
			resource: 'transactional_email',
			resourceId: args.id,
			details: {
				changedFields: 'optionalDataVariables',
				variable: args.key,
				isOptional: args.isOptional,
			},
		});
		return { optionalDataVariables };
	},
});

/**
 * Exempt a template from the per-recipient cap, or hold it to the cap again.
 * Meant for a template that only ever goes to one fixed address (a shop's own
 * new-order notification); the daily cap per API key still applies.
 */
export const setRecipientCapExempt = transactionalMutation({
	args: {
		id: v.id('transactionalEmails'),
		isExempt: v.boolean(),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'templates:manage'),
			'Only owners and admins can change the send limits of a transactional email'
		);
		await getOrThrow(ctx, args.id, 'Transactional email');
		await ctx.db.patch(args.id, {
			isRecipientCapExempt: args.isExempt ? true : undefined,
			updatedAt: Date.now(),
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'transactional_email.updated',
			resource: 'transactional_email',
			resourceId: args.id,
			details: { changedFields: 'isRecipientCapExempt', isRecipientCapExempt: args.isExempt },
		});
		return { isRecipientCapExempt: args.isExempt };
	},
});
