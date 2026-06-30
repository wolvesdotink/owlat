import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';

const modules = import.meta.glob('../**/*.*s');

/**
 * `semanticFiles.ingest` is the server-side entry point for the automatic
 * (non-upload) source types — inbound email attachments and agent artifacts.
 * Before it existed, `insertSemanticFile` had no exported caller other than the
 * user-upload `create` mutation, so the `email_attachment` / `agent_generated`
 * source filters on /dashboard/files could never match a row.
 */
describe('semanticFiles.ingest', () => {
	it('inserts an email_attachment row that the source filter can match', async () => {
		const t = convexTest(schema, modules);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['contract text'])));

		const fileId = await t.mutation(internal.semanticFiles.ingest, {
			storageId,
			filename: 'contract.pdf',
			mimeType: 'application/pdf',
			fileSize: 13,
			sourceType: 'email_attachment',
			sourceMessageId: 'msg-1@example.com',
		});

		expect(fileId).not.toBeNull();
		const row = await t.run((ctx) => ctx.db.get(fileId!));
		expect(row?.sourceType).toBe('email_attachment');
		expect(row?.sourceMessageId).toBe('msg-1@example.com');
		expect(row?.version).toBe(1);
	});

	it('ingests an agent_generated row', async () => {
		const t = convexTest(schema, modules);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['report'])));

		const fileId = await t.mutation(internal.semanticFiles.ingest, {
			storageId,
			filename: 'summary.txt',
			mimeType: 'text/plain',
			fileSize: 6,
			sourceType: 'agent_generated',
		});

		expect(fileId).not.toBeNull();
		const row = await t.run((ctx) => ctx.db.get(fileId!));
		expect(row?.sourceType).toBe('agent_generated');
	});

	it('rejects a disallowed (executable) type and drops the staged blob', async () => {
		const t = convexTest(schema, modules);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['MZ'])));

		const fileId = await t.mutation(internal.semanticFiles.ingest, {
			storageId,
			filename: 'payload.exe',
			mimeType: 'application/octet-stream',
			sourceType: 'email_attachment',
			fileSize: 2,
		});

		expect(fileId).toBeNull();
		// No semanticFiles row was created.
		const rows = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(rows).toHaveLength(0);
		// The staged blob was deleted so a rejected attachment can't leak storage.
		const blob = await t.run((ctx) => ctx.storage.get(storageId));
		expect(blob).toBeNull();
	});
});
