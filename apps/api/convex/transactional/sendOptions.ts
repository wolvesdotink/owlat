/**
 * A transactional template's settings that do not change what the email says:
 * which variables a caller may leave out and whether the template is held to
 * the per-recipient cap, which change what the send API accepts, and the
 * example values the editor preview and test sends use, which no real send
 * reads.
 *
 * None touches the content, so each applies to a published template straight
 * away, without a forced edit or a new content scan.
 */

import { v } from 'convex/values';
import { transactionalMutation } from './_helpers';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { getOrThrow, throwInvalidInput } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { dataVariableExampleValue } from '../lib/convexValidators';
import { examplesForSchema } from '@owlat/shared/dataVariableExamples';
import { examplesToStore } from './editing';

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

/**
 * Set one data variable's example value, or clear it with `example` left out.
 * The value must match the variable's declared type; an example is sample
 * data for the preview and test sends, and a real send never falls back to it.
 */
export const setVariableExample = transactionalMutation({
	args: {
		id: v.id('transactionalEmails'),
		key: v.string(),
		example: v.optional(dataVariableExampleValue),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'templates:manage'),
			'Only owners and admins can change the example values of a transactional email'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');
		if (!Object.prototype.hasOwnProperty.call(email.dataVariablesSchema ?? {}, args.key)) {
			throwInvalidInput(
				`The example for "${args.key}" names a variable the email does not declare`,
				{ reason: 'invalid_example', field: `dataVariableExamples.${args.key}` }
			);
		}
		const { [args.key]: _previous, ...rest } = examplesForSchema(
			email.dataVariablesSchema,
			email.dataVariableExamples
		);
		const next = args.example === undefined ? rest : { ...rest, [args.key]: args.example };
		const dataVariableExamples = examplesToStore(email.dataVariablesSchema, next, undefined);
		await ctx.db.patch(args.id, { dataVariableExamples, updatedAt: Date.now() });
		// The value itself stays out of the audit log: it is free text and may
		// be pasted from somewhere it should not have been.
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'transactional_email.updated',
			resource: 'transactional_email',
			resourceId: args.id,
			details: {
				changedFields: 'dataVariableExamples',
				variable: args.key,
				hasExample: args.example !== undefined,
			},
		});
		return { dataVariableExamples: dataVariableExamples ?? {} };
	},
});
