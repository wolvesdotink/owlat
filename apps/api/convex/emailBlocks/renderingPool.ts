/**
 * Saved block rerender pool — workpool declaration, the helper
 * queries/mutations the rerender action calls back into, and the
 * `onRerenderComplete` callback that records terminal-failure
 * bookkeeping on consumer rows.
 *
 * Companion to `emailBlocks/rendering.ts` which holds the `'use node'`
 * action that calls `@owlat/email-renderer`. The two files cannot
 * merge because actions ('use node') and mutations/queries run in
 * different Convex runtimes. Conceptually they own the same surface:
 * the rerender pool and its action body.
 *
 * Per ADR-0023.
 */

import { v } from 'convex/values';
import { Workpool, vOnCompleteArgs } from '@convex-dev/workpool';
import { components } from '../_generated/api';
import { internalMutation, internalQuery } from '../_generated/server';
import { recordAuditLog } from '../lib/auditLog';
import type { Doc, Id } from '../_generated/dataModel';

// ─── Workpool ───────────────────────────────────────────────────────────────

/**
 * Saved-block rerender pool. Lower parallelism than the email send pools —
 * one job per saved-block edit; each job rerenders the touched consumer
 * rows. Retries on per-row failure (the action throws); the `onComplete`
 * callback records terminal-failure bookkeeping when retries are
 * exhausted.
 */
export const rerenderBlocksPool = new Workpool(components.rerenderBlocksPool, {
	maxParallelism: 5,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		maxAttempts: 3,
		initialBackoffMs: 1000,
		base: 2,
	},
});

// ─── Helper queries / mutations ─────────────────────────────────────────────
//
// Absorbed from the pre-ADR-0023 `linkedBlockRenderHelpers.ts`. The action
// (which runs in 'use node') uses these to read and patch consumer rows
// via `ctx.runQuery` / `ctx.runMutation`.

export const getTemplate = internalQuery({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.templateId);
	},
});

export const getTransactionalEmail = internalQuery({
	args: { emailId: v.id('transactionalEmails') },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.emailId);
	},
});

/**
 * The org's configured email theme off the singleton `instanceSettings`
 * row. The rerender action reads this once per job and feeds it into the
 * renderer so propagated saved-block HTML keeps the same brand styling the
 * editor save path applies — otherwise the renderer falls back to its
 * `DEFAULT_THEME` and silently reverts the org's
 * primaryColor/fontFamily/backgroundColor/baseWidth.
 */
export const getEmailTheme = internalQuery({
	args: {},
	handler: async (ctx) => {
		const settings = await ctx.db.query('instanceSettings').first();
		return settings?.emailTheme;
	},
});

export const patchTemplateHtml = internalMutation({
	args: {
		templateId: v.id('emailTemplates'),
		htmlContent: v.string(),
		htmlTranslations: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const updates: Partial<Doc<'emailTemplates'>> = {
			htmlContent: args.htmlContent,
			// Action succeeded — clear stale flag atomically with the HTML write.
			htmlRenderState: { stale: false },
		};
		if (args.htmlTranslations !== undefined) {
			updates.htmlTranslations = args.htmlTranslations;
		}
		await ctx.db.patch(args.templateId, updates);
	},
});

export const patchTransactionalHtml = internalMutation({
	args: {
		emailId: v.id('transactionalEmails'),
		htmlContent: v.string(),
		htmlTranslations: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const updates: Partial<Doc<'transactionalEmails'>> = {
			htmlContent: args.htmlContent,
			// Action succeeded — clear stale flag atomically with the HTML write.
			htmlRenderState: { stale: false },
		};
		if (args.htmlTranslations !== undefined) {
			updates.htmlTranslations = args.htmlTranslations;
		}
		await ctx.db.patch(args.emailId, updates);
	},
});

// ─── onComplete callback ────────────────────────────────────────────────────

/**
 * Workpool `onComplete` callback. Translates the pool's terminal outcome
 * into per-row bookkeeping on the affected consumer rows.
 *
 * On terminal failure: bumps `htmlRenderState.failureCount`, sets
 * `lastFailureAt`, leaves `stale: true`, and writes an
 * `email_block.rerender_failed` audit log per consumer. On success: no
 * row writes here — the action's own mutations already cleared the
 * stale flag and persisted the new HTML.
 *
 * `vOnCompleteArgs` supplies the workpool's `{ workId, context, result }`
 * arg shape; `result` is the typed `RunResult` success/failed/canceled union.
 */
export const onRerenderComplete = internalMutation({
	args: vOnCompleteArgs(
		v.object({
			templateIds: v.array(v.id('emailTemplates')),
			transactionalIds: v.array(v.id('transactionalEmails')),
		}),
	),
	handler: async (ctx, { result, context }) => {
		// We only act on terminal failure.
		if (result.kind !== 'failed') return;

		const now = Date.now();
		const errorMessage = result.error || 'unknown';

		// One bookkeeping loop per consumer table (ADR-0023 `consumerKind`).
		// The two consumers differ only by the id array and the audit-log
		// `consumerKind` tag, so they're driven from a single descriptor list.
		const consumers: ReadonlyArray<{
			consumerKind: 'email_template' | 'transactional_email';
			ids: ReadonlyArray<Id<'emailTemplates'> | Id<'transactionalEmails'>>;
		}> = [
			{ consumerKind: 'email_template', ids: context.templateIds },
			{ consumerKind: 'transactional_email', ids: context.transactionalIds },
		];

		for (const { consumerKind, ids } of consumers) {
			for (const id of ids) {
				const row = await ctx.db.get(id);
				if (!row) continue;
				const previous = row.htmlRenderState ?? { stale: true };
				await ctx.db.patch(id, {
					htmlRenderState: {
						stale: true,
						failureCount: (previous.failureCount ?? 0) + 1,
						lastFailureAt: now,
					},
				});
				await recordAuditLog(ctx, {
					userId: 'system:rerender_pool',
					action: 'email_block.rerender_failed',
					resource: 'email_block',
					resourceId: id,
					details: {
						consumerKind,
						error: errorMessage.slice(0, 256),
					},
				});
			}
		}
	},
});
