'use node';

/**
 * Saved-block rerender action. The render itself is the shared
 * `renderPublishableEmail` (lib/publishableEmailRender.ts), which the editor save
 * and publish mutations also call. Enqueued by the saved-block module's
 * `schedule_rerender` effect into the `rerenderBlocksPool` (see
 * `renderingPool.ts`).
 *
 * Per-row failures THROW so the workpool retries the whole job; once
 * retries are exhausted the pool's `onComplete` writes the
 * `htmlRenderState.failureCount` / `lastFailureAt` patch and emits
 * `email_block.rerender_failed`. The pre-ADR-0023 fire-and-forget
 * `logError` swallow is gone.
 *
 * Per ADR-0023.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { EMAIL_RENDERER_VERSION } from '@owlat/email-renderer/version';
import type { EmailTheme } from '@owlat/shared';
import type { RerenderPatchOutcome } from './renderingPool';
import { currentContentRevision } from '../lib/contentRevision';
import {
	renderPublishableEmail,
	type PublishableEmailVariableType,
	type RenderablePublishableEmail,
	type RenderedPublishableEmail,
} from '../lib/publishableEmailRender';

// ─── Per-consumer-row rerender ───────────────────────────────────────────────
//
// The render itself is `renderPublishableEmail` in lib/publishableEmailRender.ts,
// which the editor save and publish mutations call too, so every stored HTML
// comes from the same function over the same stored blocks.

type RerenderableRow = RenderablePublishableEmail;

export function rerenderRow(
	row: RerenderableRow,
	variableType: PublishableEmailVariableType,
	theme: EmailTheme | undefined
): RenderedPublishableEmail {
	return renderPublishableEmail(row, variableType, theme);
}

/**
 * How many times one job re-reads and re-renders a row that keeps moving under
 * it before giving up and letting the workpool retry the whole job.
 */
export const MAX_RERENDER_ATTEMPTS = 3;

/**
 * Render one consumer row and patch it, guarded by the revision it was
 * rendered from. The render happens outside any transaction, so a write can
 * land between the read and the patch; the patch refuses to overwrite it. When
 * the row moved but is still stale, render again from the current row. Throws
 * once the row has moved on every attempt, so the workpool retries the job and,
 * when its retries run out, records the failure on the row.
 */
export async function rerenderConsumerRow<Row extends RerenderableRow>(deps: {
	load: () => Promise<Row | null>;
	render: (row: Row) => ReturnType<typeof rerenderRow>;
	patch: (row: Row, rendered: ReturnType<typeof rerenderRow>) => Promise<RerenderPatchOutcome>;
}): Promise<RerenderPatchOutcome> {
	for (let attempt = 0; attempt < MAX_RERENDER_ATTEMPTS; attempt++) {
		const row = await deps.load();
		if (!row) return 'gone';
		const outcome = await deps.patch(row, deps.render(row));
		if (outcome !== 'moved') return outcome;
	}
	throw new Error(
		`Consumer row kept changing during the saved-block rerender (${MAX_RERENDER_ATTEMPTS} attempts)`
	);
}

export const reRenderEmails = internalAction({
	args: {
		templateIds: v.array(v.id('emailTemplates')),
		transactionalIds: v.array(v.id('transactionalEmails')),
	},
	handler: async (ctx, args) => {
		// Load the org's email theme once so propagated HTML keeps the same
		// brand styling the editor save path applies — without it the renderer
		// falls back to DEFAULT_THEME and silently reverts the org's
		// primaryColor/fontFamily/backgroundColor/baseWidth on every consumer.
		const theme =
			(await ctx.runQuery(internal.emailBlocks.renderingPool.getEmailTheme, {})) ?? undefined;

		for (const templateId of args.templateIds) {
			await rerenderConsumerRow({
				load: () => ctx.runQuery(internal.emailBlocks.renderingPool.getTemplate, { templateId }),
				render: (template) => rerenderRow(template, 'personalization', theme),
				patch: (template, { html, htmlTranslations, plainTextContent }) =>
					ctx.runMutation(internal.emailBlocks.renderingPool.patchTemplateHtml, {
						templateId,
						htmlContent: html,
						htmlTranslations,
						plainTextContent,
						expectedContentRevision: currentContentRevision(template),
						rendererVersion: EMAIL_RENDERER_VERSION,
					}),
			});
		}

		for (const emailId of args.transactionalIds) {
			await rerenderConsumerRow({
				load: () =>
					ctx.runQuery(internal.emailBlocks.renderingPool.getTransactionalEmail, { emailId }),
				render: (email) => rerenderRow(email, 'data', theme),
				patch: (email, { html, htmlTranslations, plainTextContent }) =>
					ctx.runMutation(internal.emailBlocks.renderingPool.patchTransactionalHtml, {
						emailId,
						htmlContent: html,
						htmlTranslations,
						plainTextContent,
						expectedContentRevision: currentContentRevision(email),
						rendererVersion: EMAIL_RENDERER_VERSION,
					}),
			});
		}
	},
});
