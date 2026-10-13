/**
 * Migration 0069: knowledge extracted from captured mail attachments before
 * the marker existed gets the file's `captureSource`, over both passes and
 * several pages; knowledge from an uploaded file is left member-visible.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules } from '../../mail/__tests__/helpers.testlib';
import { MIGRATION } from '../0069_restrict_captured_file_knowledge';
import { isInboxDerivedKnowledge } from '../../inbox/access';

const migration = internal.migrations[MIGRATION];

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('0069_restrict_captured_file_knowledge', () => {
	it('stamps entries from captured files only, across passes and pages', async () => {
		const t = convexTest(schema, modules);
		const entryOf = new Map<Id<'knowledgeEntries'>, string>();
		await t.run(async (ctx) => {
			const file = (captureSource?: Doc<'semanticFiles'>['captureSource']) =>
				ctx.db.insert('semanticFiles', {
					filename: 'f.txt',
					mimeType: 'text/plain',
					fileSize: 1,
					sourceType: captureSource ? 'email_attachment' : 'upload',
					captureSource,
					version: 1,
					embedding: [],
					createdAt: 1,
					updatedAt: 1,
				});
			const entry = async (fileId: Id<'semanticFiles'>, label: string) => {
				const id = await ctx.db.insert('knowledgeEntries', {
					entryType: 'fact',
					title: label,
					content: label,
					sourceType: 'file',
					sourceId: fileId,
					embedding: [],
					confidence: 0.8,
					lastValidatedAt: 1,
					createdAt: 1,
					updatedAt: 1,
				});
				entryOf.set(id, label);
			};
			// More captures than one page in the first pass.
			for (let i = 0; i < 60; i++) await entry(await file('team_inbox'), 'team_inbox');
			await entry(await file('mailbox'), 'mailbox');
			await entry(await file(), 'upload');
		});

		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			for (const [id, label] of entryOf) {
				const row = (await ctx.db.get(id))!;
				expect(row.captureSource).toBe(label === 'upload' ? undefined : label);
				expect(isInboxDerivedKnowledge(row)).toBe(label !== 'upload');
			}
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.first();
			expect(run?.status).toBe('completed');
		});
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});
});
