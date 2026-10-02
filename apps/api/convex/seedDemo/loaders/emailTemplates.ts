/**
 * Seed loader: emailTemplates.
 *
 * Direct insert — public mutation is session-gated and triggers the saved-block
 * rerender pool. The content still goes through the write-time sanitizer, and
 * `htmlContent` is rendered here from the sanitized blocks, as an editor save
 * does (lib/publishableEmail.ts).
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { sanitizeStoredBlocksJson } from '../../lib/emailContentSanitize';
import { recordListingCounter } from '../../lib/listingCounters';
import { loadEmailTheme, renderPublishableEmail } from '../../lib/publishableEmailRender';
import { SEED_TAG, type LoadResult, type Loader } from './types';

type TemplateType = 'marketing' | 'transactional';
type TemplateStatus = 'draft' | 'published';

interface TemplateFixture {
	slug: string;
	name: string;
	type: TemplateType;
	subject: string;
	previewText?: string;
	status: TemplateStatus;
	content: string;
}

async function load(ctx: MutationCtx, rawRecords: unknown[]): Promise<LoadResult> {
	const records = rawRecords as TemplateFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'emailTemplates'>> = {};
	const now = Date.now();

	const existing = await ctx.db.query('emailTemplates').collect(); // bounded: tiny seed table
	const byName = new Map(existing.map((t) => [t.name, t]));
	const theme = await loadEmailTheme(ctx);

	for (const rec of records) {
		const found = byName.get(rec.name);
		if (found) {
			ids[rec.slug] = found._id;
			skipped++;
			continue;
		}
		const content = sanitizeStoredBlocksJson(rec.content);
		const rendered = renderPublishableEmail(
			{ content, subject: rec.subject },
			'personalization',
			theme
		);
		const id = await ctx.db.insert('emailTemplates', {
			name: rec.name,
			type: rec.type,
			subject: rec.subject,
			previewText: rec.previewText,
			status: rec.status,
			content,
			htmlContent: rendered.html,
			publishedAt: rec.status === 'published' ? now : undefined,
			searchableText: `${rec.name} ${rec.subject}`,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});
		await recordListingCounter(ctx, 'templateType', null, { type: rec.type });
		ids[rec.slug] = id;
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const emailTemplatesLoader: Loader = {
	module: 'emailTemplates',
	dependencies: [],
	load,
};
