/**
 * The media library and system mail endpoints (`workspaces/mediaAssets`,
 * `workspaces/mediaAssetScan`, `auth/accountDeletionEmail`,
 * `contacts/confirmationEmail{,Queries}`): what each reads, writes, schedules
 * and sends, and the auth floor each keeps. The clock is faked; scheduled work
 * is read by the function it targets and never run. The system mail transport
 * is replaced by a stub that records what it was asked to send.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { internalAction } from '../_generated/server';
import * as runtimeLog from '../lib/runtimeLog';
import { systemMailArgs } from '../maintenance/systemMail';
import { createTestInstanceSettings } from './factories';
import { recordUploadedBlob } from './uploadFixtures.testlib';

const session = vi.hoisted(() => ({
	role: 'owner' as 'owner' | 'admin' | 'editor',
	isMember: true,
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../lib/sessionOrganization');
	const member = () => {
		if (!session.isMember) throw new Error('forbidden: not an org member');
		return { userId: 'test-user', role: session.role, activeOrganizationId: 'org-1' };
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => member()),
		getMutationContext: vi.fn(async () => member()),
		isActiveOrgMember: vi.fn(async () => session.isMember),
	};
});

/** What the stubbed system mail transport was asked to send, in order. */
const sent = vi.hoisted(() => [] as unknown[]);

const modules = {
	...import.meta.glob('../**/*.*s'),
	'../maintenance/systemMail.ts': async () => ({
		sendSystemEmail: internalAction({
			args: systemMailArgs,
			handler: async (_ctx, args) => {
				sent.push(args);
				return null;
			},
		}),
	}),
};
const NOW = Date.UTC(2026, 9, 1, 12);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** A Windows executable's `MZ` signature behind an image name. */
const PE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 3, 0, 0, 0, 4, 0, 0, 0]);

type T = TestConvex<typeof schema>;

beforeEach(() => {
	session.role = 'owner';
	session.isMember = true;
	sent.length = 0;
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.spyOn(runtimeLog, 'logError').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** A blob the caller uploaded and has not registered yet. */
async function uploaded(t: T, bytes: Uint8Array = PNG): Promise<Id<'_storage'>> {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(
			new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' })
		);
		await recordUploadedBlob(ctx, storageId, 'test-user', 'org-1');
		return storageId;
	});
}

/** A library asset whose recorded size is `claimed`, as the client reported it. */
async function asset(t: T, bytes: Uint8Array, claimed: number) {
	const storageId = await uploaded(t, bytes);
	const assetId = await t.mutation(api.workspaces.mediaAssets.create, {
		storageId,
		filename: 'logo.png',
		mimeType: 'image/png',
		fileSize: claimed,
	});
	// `create` stores the server-measured size; put the client's claim back.
	await t.run(async (ctx) => await ctx.db.patch(assetId, { fileSize: claimed }));
	return { assetId, storageId };
}

/**
 * The rows a write leaves behind, without their ids, blob ids and URLs, plus
 * the function each scheduled job targets.
 */
async function written(t: T) {
	return await t.run(async (ctx) => ({
		mediaAssets: (await ctx.db.query('mediaAssets').collect()).map(
			({ _id, _creationTime, storageId, url, ...rest }) => rest
		),
		storageUploads: (await ctx.db.query('storageUploads').collect()).map(
			({ _id, _creationTime, storageId, resourceKey, ...rest }) => rest
		),
		scheduled: (await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name),
	}));
}

describe('media library endpoints', () => {
	it('create, update and bulkDelete write the asset and its upload record, and schedule the byte scan', async () => {
		const t = convexTest(schema, modules);
		const assetId = await t.mutation(api.workspaces.mediaAssets.create, {
			storageId: await uploaded(t),
			filename: 'logo.png',
			mimeType: 'image/png',
			fileSize: 1,
			tags: ['brand'],
		});
		const created = await written(t);
		// The stored size is the measured one, not the client's claim.
		expect(created.mediaAssets).toMatchObject([{ filename: 'logo.png', fileSize: PNG.length }]);
		expect(created.storageUploads).toMatchObject([{ status: 'bound' }]);
		expect(created.scheduled).toEqual(['workspaces/mediaAssetScan:scanAssetBytes']);

		const edit = { alt: 'The logo', tags: ['brand', 'dark'] };
		await t.mutation(api.workspaces.mediaAssets.update, { assetId, ...edit });
		expect((await written(t)).mediaAssets).toMatchObject([edit]);

		await t.mutation(api.workspaces.mediaAssets.bulkDelete, { assetIds: [assetId] });
		const after = await written(t);
		expect(after.mediaAssets).toEqual([]);
		expect(after.storageUploads).toEqual([]);
	});

	it("the reads answer the library, its totals, an asset's usage and the tags", async () => {
		const t = convexTest(schema, modules);
		const { assetId, storageId } = await asset(t, PNG, PNG.length);
		await t.mutation(api.workspaces.mediaAssets.update, { assetId, tags: ['brand'] });
		await t.run(async (ctx) => {
			await ctx.db.insert('emailBlocks', {
				name: 'Header',
				content: JSON.stringify({ storageId }),
				usageCount: 0,
				createdAt: NOW,
				updatedAt: NOW,
			});
		});
		const page = { paginationOpts: { numItems: 10, cursor: null } };

		const list = await t.query(api.workspaces.mediaAssets.list, page);
		expect(list.page.map((row) => row.filename)).toEqual(['logo.png']);

		expect(await t.query(api.workspaces.mediaAssets.getStats, {})).toEqual({
			totalCount: 1,
			totalBytes: PNG.length,
			truncated: false,
		});
		expect(await t.query(api.workspaces.mediaAssets.countUsage, { assetId })).toEqual({ count: 1 });
		expect(await t.query(api.workspaces.mediaAssets.listTags, {})).toEqual(['brand']);
	});

	it('keep the media:manage write floor and the member read floor', async () => {
		const t = convexTest(schema, modules);
		const { assetId } = await asset(t, PNG, PNG.length);
		const storageId = await uploaded(t);

		session.role = 'editor';
		await expect(
			t.mutation(api.workspaces.mediaAssets.create, {
				storageId,
				filename: 'other.png',
				mimeType: 'image/png',
				fileSize: 1,
			})
		).rejects.toThrow('Only owners and admins can create media assets');
		await expect(
			t.mutation(api.workspaces.mediaAssets.update, { assetId, alt: 'Nope' })
		).rejects.toThrow('Only owners and admins can update media assets');
		await expect(
			t.mutation(api.workspaces.mediaAssets.bulkDelete, { assetIds: [assetId] })
		).rejects.toThrow('Only owners and admins can bulk-delete media assets');
		// An editor still reads the library, as every member does.
		expect(await t.query(api.workspaces.mediaAssets.getStats, {})).toMatchObject({ totalCount: 1 });

		session.isMember = false;
		const notMember = /not an org member/;
		const page = { paginationOpts: { numItems: 10, cursor: null } };
		await expect(t.query(api.workspaces.mediaAssets.list, page)).rejects.toThrow(notMember);
		await expect(t.query(api.workspaces.mediaAssets.getStats, {})).rejects.toThrow(notMember);
		await expect(t.query(api.workspaces.mediaAssets.countUsage, { assetId })).rejects.toThrow(
			notMember
		);
		await expect(t.query(api.workspaces.mediaAssets.listTags, {})).rejects.toThrow(notMember);
		// Nothing the refused writes asked for landed.
		expect((await written(t)).mediaAssets.map((row) => [row.filename, row.alt])).toEqual([
			['logo.png', undefined],
		]);
	});
});

describe('upload scan', () => {
	it('scanAssetBytes quarantines a disguised or under-reported upload and corrects a small drift', async () => {
		for (const [bytes, claimed, kept] of [
			// A disguised executable is quarantined.
			[PE, PE.length, []],
			// A small drift is corrected to the measured size.
			[PNG, PNG.length - 1, [PNG.length]],
			// A gross under-report is quarantined.
			[PNG, 2, []],
		] as const) {
			const t = convexTest(schema, modules);
			await t.action(
				internal.workspaces.mediaAssetScan.scanAssetBytes,
				await asset(t, bytes, claimed)
			);
			expect((await written(t)).mediaAssets.map((row) => row.fileSize)).toEqual(kept);
		}
	});

	it('reconcileAssetSize stores the measured size; quarantineAsset deletes the asset and its upload', async () => {
		const t = convexTest(schema, modules);
		const stored = await asset(t, PNG, PNG.length - 1);

		await t.mutation(internal.workspaces.mediaAssetScan.reconcileAssetSize, {
			...stored,
			actualSize: PNG.length,
		});
		expect((await written(t)).mediaAssets).toMatchObject([{ fileSize: PNG.length }]);

		await t.mutation(internal.workspaces.mediaAssetScan.quarantineAsset, {
			...stored,
			reason: 'dangerous file signature',
		});
		const after = await written(t);
		expect(after.mediaAssets).toEqual([]);
		expect(after.storageUploads).toEqual([]);
	});
});

describe('system mail actions', () => {
	it('sendAccountDeletionEmail sends the localized mail with the cancellation link', async () => {
		const t = convexTest(schema, modules);
		const args = {
			email: 'leaving@example.com',
			scheduledForDeletion: NOW,
			cancellationToken: 'cancel token',
			siteUrl: 'https://owlat.example',
			locale: 'de' as const,
		};

		expect(
			await t.action(internal.auth.accountDeletionEmail.sendAccountDeletionEmail, args)
		).toEqual({ success: true });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ to: 'leaving@example.com' });
		expect((sent[0] as { html: string }).html).toContain('cancel-deletion?token=cancel%20token');
	});

	it('sendConfirmationEmail sends the DOI mail from the default sender', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'instanceSettings',
				createTestInstanceSettings({
					defaultFromName: 'Owlat News',
					defaultFromEmail: 'news@owlat.example',
				})
			);
		});
		const args = {
			email: 'reader@example.com',
			firstName: 'Ada',
			confirmationToken: 'doi-token',
			siteUrl: 'https://owlat.example',
		};

		expect(await t.action(internal.contacts.confirmationEmail.sendConfirmationEmail, args)).toEqual(
			{ success: true }
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			to: 'reader@example.com',
			subject: 'Confirm your subscription to Owlat News',
		});
		expect((sent[0] as { from: string }).from).toContain('news@owlat.example');

		expect(await t.query(internal.contacts.confirmationEmailQueries.getTeamInfo, {})).toEqual({
			name: 'Owlat News',
			defaultFromName: 'Owlat News',
			defaultFromEmail: 'news@owlat.example',
		});
	});
});
