/**
 * Seed loader: emailTemplates.
 *
 * Direct insert — public mutation is session-gated and triggers the saved-block
 * rerender pool. Seeded templates are pre-rendered into `htmlContent`, so the
 * rerender pool would have nothing to do anyway.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
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
	htmlContent?: string;
}

async function load(
	ctx: MutationCtx,
	rawRecords: unknown[],
): Promise<LoadResult> {
	const records = rawRecords as TemplateFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'emailTemplates'>> = {};
	const now = Date.now();

	const existing = await ctx.db.query('emailTemplates').collect(); // bounded: tiny seed table
	const byName = new Map(existing.map((t) => [t.name, t]));

	for (const rec of records) {
		const found = byName.get(rec.name);
		if (found) {
			ids[rec.slug] = found._id;
			skipped++;
			continue;
		}
		const id = await ctx.db.insert('emailTemplates', {
			name: rec.name,
			type: rec.type,
			subject: rec.subject,
			previewText: rec.previewText,
			status: rec.status,
			content: rec.content,
			htmlContent: rec.htmlContent,
			publishedAt: rec.status === 'published' ? now : undefined,
			searchableText: `${rec.name} ${rec.subject}`,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});
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
