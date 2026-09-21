import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';

const migration = internal.migrations['0044_private_chat_media'];

describe('0044 private chat media backfill', () => {
	it('restores a stripped tag and all aliases across pages, and is idempotent', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['private content']));
			const rows = [];
			for (let i = 0; i < 105; i++) {
				rows.push(
					await ctx.db.insert('mediaAssets', {
						storageId,
						filename: `alias-${i}.txt`,
						mimeType: 'text/plain',
						fileSize: 15,
						url: 'https://owlat.example/file',
						uploadedBy: 'alice',
						tags: ['legacy'],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					})
				);
			}
			const roomId = await ctx.db.insert('chatRooms', {
				kind: 'dm',
				name: 'Private',
				normalizedName: 'alice,bob',
				visibility: 'private',
				createdBy: 'alice',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				lastMessageAt: Date.now(),
				messageCount: 1,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'alice',
				text: 'Private file',
				attachmentIds: [rows[0]!],
				createdAt: Date.now(),
			});
			return rows;
		});
		expect(await t.action(migration.run, {})).toEqual({ updated: 105 });
		const tags = await t.run(async (ctx) =>
			Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.tags))
		);
		expect(
			tags.every((value) => value?.includes('chat-attachment') && value.includes('legacy'))
		).toBe(true);
		expect(await t.action(migration.run, {})).toEqual({ updated: 0 });
	});

	it('repairs unposted tagged uploads without changing unrelated shared assets', async () => {
		const t = convexTest(schema, modules);
		const { alias, shared } = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['private upload']));
			const common = {
				storageId,
				filename: 'file.txt',
				mimeType: 'text/plain',
				fileSize: 14,
				url: 'https://owlat.example/file',
				uploadedBy: 'alice',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			await ctx.db.insert('mediaAssets', { ...common, tags: ['chat-attachment'] });
			const alias = await ctx.db.insert('mediaAssets', common);
			const shared = await ctx.db.insert('mediaAssets', {
				...common,
				storageId: await ctx.storage.store(new Blob(['marketing'])),
				tags: ['branding'],
			});
			return { alias, shared };
		});
		expect(await t.action(migration.run, {})).toEqual({ updated: 1 });
		expect((await t.run((ctx) => ctx.db.get(alias)))?.tags).toEqual(['chat-attachment']);
		expect((await t.run((ctx) => ctx.db.get(shared)))?.tags).toEqual(['branding']);
	});
});
