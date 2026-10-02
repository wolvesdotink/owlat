/**
 * Seed loader: transactionalEmails (API-triggered templates, separate table
 * from marketing emailTemplates).
 *
 * Direct insert — the public creation path is session-gated and runs the
 * content scan (pending_review hold); seeded fixtures are trusted demo
 * content, so we skip both. The content still goes through the write-time
 * sanitizer, and `htmlContent` is rendered here from the sanitized blocks, as
 * an editor save does (lib/publishableEmail.ts).
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { sanitizeStoredBlocksJson } from '../../lib/emailContentSanitize';
import { loadEmailTheme, renderPublishableEmail } from '../../lib/publishableEmailRender';
import { SEED_TAG, type LoadResult, type Loader } from './types';

type TransactionalStatus = 'draft' | 'published';
type DataVariableType = 'string' | 'number' | 'boolean' | 'date';

interface TransactionalEmailFixture {
	slug: string;
	name: string;
	subject: string;
	status: TransactionalStatus;
	content: string;
	dataVariablesSchema?: Record<string, DataVariableType>;
	showUnsubscribe?: boolean;
}

async function load(ctx: MutationCtx, rawRecords: unknown[]): Promise<LoadResult> {
	const records = rawRecords as TransactionalEmailFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'transactionalEmails'>> = {};
	const now = Date.now();

	const existing = await ctx.db.query('transactionalEmails').collect(); // bounded: tiny seed table
	const bySlug = new Map(existing.map((t) => [t.slug, t]));
	const theme = await loadEmailTheme(ctx);

	for (const rec of records) {
		const found = bySlug.get(rec.slug);
		if (found) {
			ids[rec.slug] = found._id;
			skipped++;
			continue;
		}
		const content = sanitizeStoredBlocksJson(rec.content);
		const rendered = renderPublishableEmail({ content, subject: rec.subject }, 'data', theme);
		const id = await ctx.db.insert('transactionalEmails', {
			name: rec.name,
			slug: rec.slug,
			subject: rec.subject,
			content,
			htmlContent: rendered.html,
			dataVariablesSchema: rec.dataVariablesSchema,
			status: rec.status,
			publishedAt: rec.status === 'published' ? now : undefined,
			showUnsubscribe: rec.showUnsubscribe ?? false,
			searchableText: `${rec.name} ${rec.subject} ${rec.slug}`,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});
		ids[rec.slug] = id;
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const transactionalEmailsLoader: Loader = {
	module: 'transactionalEmails',
	dependencies: [],
	load,
};
