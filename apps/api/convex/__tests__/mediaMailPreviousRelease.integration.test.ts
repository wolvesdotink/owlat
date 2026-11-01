/**
 * The previous release's media library and system mail paths
 * (`mediaAssets:*`, `accountDeletionEmail:*`, `confirmationEmail:*`,
 * `confirmationEmailQueries:*`) keep working against this release: each old
 * path takes the same arguments, declares the same result, keeps its auth
 * floor, and reads, writes and sends what its moved function in
 * `workspaces/mediaAssets`, `workspaces/mediaAssetScan`,
 * `auth/accountDeletionEmail` or `contacts/confirmationEmail{,Queries}` does.
 *
 * Writes are compared across two fresh deployments seeded alike, one driven
 * through the old path and one through the new, with the clock faked so both
 * stamp the same times. Scheduled work is compared by the function it targets
 * and never run. The system mail transport is replaced by a stub that records
 * what it was asked to send.
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
import * as oldMediaAssets from '../mediaAssets';
import * as oldAccountDeletionEmail from '../accountDeletionEmail';
import * as oldConfirmationEmail from '../confirmationEmail';
import * as oldConfirmationEmailQueries from '../confirmationEmailQueries';
import * as mediaAssets from '../workspaces/mediaAssets';
import * as mediaAssetScan from '../workspaces/mediaAssetScan';
import * as accountDeletionEmail from '../auth/accountDeletionEmail';
import * as confirmationEmail from '../contacts/confirmationEmail';
import * as confirmationEmailQueries from '../contacts/confirmationEmailQueries';

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
 * The rows a write leaves behind, without the ids, blob ids and URLs two
 * deployments assign independently, plus the function each scheduled job
 * targets.
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

describe('previous-release media and mail paths: shapes', () => {
	it('keep the builder kind, visibility, arguments and result of the moved functions', () => {
		const shape = (fn: unknown) => {
			const registered = fn as {
				isQuery?: boolean;
				isMutation?: boolean;
				isAction?: boolean;
				isPublic?: boolean;
				isInternal?: boolean;
				exportArgs(): string;
				exportReturns(): string;
			};
			return {
				kind: [registered.isQuery, registered.isMutation, registered.isAction],
				visibility: [registered.isPublic, registered.isInternal],
				args: registered.exportArgs(),
				returns: registered.exportReturns(),
			};
		};
		const pairs: [unknown, unknown][] = [
			[oldMediaAssets.list, mediaAssets.list],
			[oldMediaAssets.getStats, mediaAssets.getStats],
			[oldMediaAssets.countUsage, mediaAssets.countUsage],
			[oldMediaAssets.listTags, mediaAssets.listTags],
			[oldMediaAssets.create, mediaAssets.create],
			[oldMediaAssets.update, mediaAssets.update],
			[oldMediaAssets.bulkDelete, mediaAssets.bulkDelete],
			[oldMediaAssets.scanAssetBytes, mediaAssetScan.scanAssetBytes],
			[oldMediaAssets.reconcileAssetSize, mediaAssetScan.reconcileAssetSize],
			[oldMediaAssets.quarantineAsset, mediaAssetScan.quarantineAsset],
			[
				oldAccountDeletionEmail.sendAccountDeletionEmail,
				accountDeletionEmail.sendAccountDeletionEmail,
			],
			[oldConfirmationEmail.sendConfirmationEmail, confirmationEmail.sendConfirmationEmail],
			[oldConfirmationEmailQueries.getTeamInfo, confirmationEmailQueries.getTeamInfo],
		];
		expect(pairs).toHaveLength(13);
		for (const [old, moved] of pairs) expect(shape(old)).toEqual(shape(moved));
		// Every root export is one of the pairs above: no old path was dropped.
		expect(Object.keys(oldMediaAssets).sort()).toEqual(
			[
				'bulkDelete',
				'countUsage',
				'create',
				'getStats',
				'list',
				'listTags',
				'quarantineAsset',
				'reconcileAssetSize',
				'scanAssetBytes',
				'update',
			].sort()
		);
		expect(Object.keys(oldAccountDeletionEmail)).toEqual(['sendAccountDeletionEmail']);
		expect(Object.keys(oldConfirmationEmail)).toEqual(['sendConfirmationEmail']);
		expect(Object.keys(oldConfirmationEmailQueries)).toEqual(['getTeamInfo']);
	});
});

describe('previous-release media library paths', () => {
	it('mediaAssets:create, update and bulkDelete write what workspaces/mediaAssets does', async () => {
		const old = convexTest(schema, modules);
		const moved = convexTest(schema, modules);
		const upload = { filename: 'logo.png', mimeType: 'image/png', fileSize: 1, tags: ['brand'] };

		const oldId = await old.mutation(api.mediaAssets.create, {
			storageId: await uploaded(old),
			...upload,
		});
		const newId = await moved.mutation(api.workspaces.mediaAssets.create, {
			storageId: await uploaded(moved),
			...upload,
		});
		const created = await written(old);
		expect(created).toEqual(await written(moved));
		expect(created.mediaAssets).toMatchObject([{ filename: 'logo.png', fileSize: PNG.length }]);
		expect(created.storageUploads).toMatchObject([{ status: 'bound' }]);
		// The old path schedules the byte scan this release runs, not a root path.
		expect(created.scheduled).toEqual(['workspaces/mediaAssetScan:scanAssetBytes']);

		const edit = { alt: 'The logo', tags: ['brand', 'dark'] };
		await old.mutation(api.mediaAssets.update, { assetId: oldId, ...edit });
		await moved.mutation(api.workspaces.mediaAssets.update, { assetId: newId, ...edit });
		const updated = await written(old);
		expect(updated).toEqual(await written(moved));
		expect(updated.mediaAssets).toMatchObject([edit]);

		await old.mutation(api.mediaAssets.bulkDelete, { assetIds: [oldId] });
		await moved.mutation(api.workspaces.mediaAssets.bulkDelete, { assetIds: [newId] });
		const after = await written(old);
		expect(after).toEqual(await written(moved));
		expect(after.mediaAssets).toEqual([]);
		expect(after.storageUploads).toEqual([]);
	});

	it('the old media library reads answer what workspaces/mediaAssets answers', async () => {
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

		const list = await t.query(api.mediaAssets.list, page);
		expect(list.page.map((row) => row.filename)).toEqual(['logo.png']);
		expect(list).toEqual(await t.query(api.workspaces.mediaAssets.list, page));

		const stats = await t.query(api.mediaAssets.getStats, {});
		expect(stats).toEqual({ totalCount: 1, totalBytes: PNG.length, truncated: false });
		expect(stats).toEqual(await t.query(api.workspaces.mediaAssets.getStats, {}));

		const usage = await t.query(api.mediaAssets.countUsage, { assetId });
		expect(usage).toEqual({ count: 1 });
		expect(usage).toEqual(await t.query(api.workspaces.mediaAssets.countUsage, { assetId }));

		const tags = await t.query(api.mediaAssets.listTags, {});
		expect(tags).toEqual(['brand']);
		expect(tags).toEqual(await t.query(api.workspaces.mediaAssets.listTags, {}));
	});

	it('keep the media:manage write floor and the member read floor on the old paths', async () => {
		const t = convexTest(schema, modules);
		const { assetId } = await asset(t, PNG, PNG.length);
		const storageId = await uploaded(t);

		session.role = 'editor';
		await expect(
			t.mutation(api.mediaAssets.create, {
				storageId,
				filename: 'other.png',
				mimeType: 'image/png',
				fileSize: 1,
			})
		).rejects.toThrow('Only owners and admins can create media assets');
		await expect(t.mutation(api.mediaAssets.update, { assetId, alt: 'Nope' })).rejects.toThrow(
			'Only owners and admins can update media assets'
		);
		await expect(t.mutation(api.mediaAssets.bulkDelete, { assetIds: [assetId] })).rejects.toThrow(
			'Only owners and admins can bulk-delete media assets'
		);
		// An editor still reads the library, as every member does.
		expect(await t.query(api.mediaAssets.getStats, {})).toMatchObject({ totalCount: 1 });

		session.isMember = false;
		const notMember = /not an org member/;
		const page = { paginationOpts: { numItems: 10, cursor: null } };
		await expect(t.query(api.mediaAssets.list, page)).rejects.toThrow(notMember);
		await expect(t.query(api.mediaAssets.getStats, {})).rejects.toThrow(notMember);
		await expect(t.query(api.mediaAssets.countUsage, { assetId })).rejects.toThrow(notMember);
		await expect(t.query(api.mediaAssets.listTags, {})).rejects.toThrow(notMember);
		// Nothing the refused writes asked for landed.
		expect((await written(t)).mediaAssets.map((row) => [row.filename, row.alt])).toEqual([
			['logo.png', undefined],
		]);
	});
});

describe('previous-release upload scan paths', () => {
	it('mediaAssets:scanAssetBytes quarantines and reconciles what workspaces/mediaAssetScan does', async () => {
		for (const [bytes, claimed, kept] of [
			// A disguised executable is quarantined.
			[PE, PE.length, []],
			// A small drift is corrected to the measured size.
			[PNG, PNG.length - 1, [PNG.length]],
			// A gross under-report is quarantined.
			[PNG, 2, []],
		] as const) {
			const old = convexTest(schema, modules);
			const moved = convexTest(schema, modules);
			const oldAsset = await asset(old, bytes, claimed);
			const newAsset = await asset(moved, bytes, claimed);

			await old.action(internal.mediaAssets.scanAssetBytes, oldAsset);
			await moved.action(internal.workspaces.mediaAssetScan.scanAssetBytes, newAsset);
			const after = await written(old);
			expect(after).toEqual(await written(moved));
			expect(after.mediaAssets.map((row) => row.fileSize)).toEqual(kept);
		}
	});

	it('mediaAssets:reconcileAssetSize and quarantineAsset write what workspaces/mediaAssetScan does', async () => {
		const old = convexTest(schema, modules);
		const moved = convexTest(schema, modules);
		const oldAsset = await asset(old, PNG, PNG.length - 1);
		const newAsset = await asset(moved, PNG, PNG.length - 1);

		const measured = { actualSize: PNG.length };
		await old.mutation(internal.mediaAssets.reconcileAssetSize, { ...oldAsset, ...measured });
		await moved.mutation(internal.workspaces.mediaAssetScan.reconcileAssetSize, {
			...newAsset,
			...measured,
		});
		const reconciled = await written(old);
		expect(reconciled).toEqual(await written(moved));
		expect(reconciled.mediaAssets).toMatchObject([{ fileSize: PNG.length }]);

		const reason = { reason: 'dangerous file signature' };
		await old.mutation(internal.mediaAssets.quarantineAsset, { ...oldAsset, ...reason });
		await moved.mutation(internal.workspaces.mediaAssetScan.quarantineAsset, {
			...newAsset,
			...reason,
		});
		const after = await written(old);
		expect(after).toEqual(await written(moved));
		expect(after.mediaAssets).toEqual([]);
		expect(after.storageUploads).toEqual([]);
	});
});

describe('previous-release system mail paths', () => {
	it('accountDeletionEmail:sendAccountDeletionEmail sends what auth/accountDeletionEmail does', async () => {
		const t = convexTest(schema, modules);
		const args = {
			email: 'leaving@example.com',
			scheduledForDeletion: NOW,
			cancellationToken: 'cancel token',
			siteUrl: 'https://owlat.example',
			locale: 'de' as const,
		};

		const oldResult = await t.action(internal.accountDeletionEmail.sendAccountDeletionEmail, args);
		const newResult = await t.action(
			internal.auth.accountDeletionEmail.sendAccountDeletionEmail,
			args
		);
		expect(oldResult).toEqual({ success: true });
		expect(newResult).toEqual(oldResult);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toEqual(sent[1]);
		expect(sent[0]).toMatchObject({ to: 'leaving@example.com' });
		expect((sent[0] as { html: string }).html).toContain('cancel-deletion?token=cancel%20token');
	});

	it('confirmationEmail:sendConfirmationEmail sends what contacts/confirmationEmail does', async () => {
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

		const oldResult = await t.action(internal.confirmationEmail.sendConfirmationEmail, args);
		const newResult = await t.action(
			internal.contacts.confirmationEmail.sendConfirmationEmail,
			args
		);
		expect(oldResult).toEqual({ success: true });
		expect(newResult).toEqual(oldResult);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toEqual(sent[1]);
		expect(sent[0]).toMatchObject({
			to: 'reader@example.com',
			subject: 'Confirm your subscription to Owlat News',
		});
		expect((sent[0] as { from: string }).from).toContain('news@owlat.example');

		const sender = await t.query(internal.confirmationEmailQueries.getTeamInfo, {});
		expect(sender).toEqual({
			name: 'Owlat News',
			defaultFromName: 'Owlat News',
			defaultFromEmail: 'news@owlat.example',
		});
		expect(sender).toEqual(
			await t.query(internal.contacts.confirmationEmailQueries.getTeamInfo, {})
		);
	});
});
