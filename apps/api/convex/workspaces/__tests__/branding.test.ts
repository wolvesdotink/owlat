/**
 * Workspace logo (#810): an owner or admin binds an uploaded PNG/JPEG/SVG as
 * the workspace logo, the public recipient-sender read hands its URL to the
 * sign-in and recipient pages, and a file whose bytes are not the declared
 * image is taken down again.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { MAX_WORKSPACE_LOGO_BYTES } from '@owlat/shared/workspaceLogo';
import { recordUploadedBlob } from '../../__tests__/uploadFixtures.testlib';

const session = vi.hoisted(() => ({
	userId: 'user-A',
	activeOrganizationId: 'org-1',
	role: 'owner' as string,
}));
vi.mock('../../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../../lib/sessionOrganization')),
	getMutationContext: vi.fn(async () => ({ ...session })),
	requireOrgMember: vi.fn(async () => ({ ...session })),
	getBetterAuthSessionWithRole: vi.fn(async () => ({ ...session })),
	getUserIdFromSession: vi.fn(async () => session.userId),
	isActiveOrgMember: vi.fn(async () => true),
}));

// Same re-prefixing as settings.test.ts: Vite keys siblings in this subtree as
// '../X', which convex-test would never match.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) => {
		if (key.startsWith('../') && !key.startsWith('../../')) {
			return ['../../workspaces/' + key.slice(3), val];
		}
		return [key, val];
	})
);

type Harness = TestConvex<typeof schema>;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

beforeEach(() => {
	session.userId = 'user-A';
	session.role = 'owner';
});
afterEach(() => {
	vi.useRealTimers();
});

async function uploaded(t: Harness, bytes: Uint8Array | string, owner = 'user-A') {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob([bytes as BlobPart]));
		await recordUploadedBlob(ctx, storageId, owner);
		return storageId;
	});
}

async function settingsRow(t: Harness) {
	return t.run((ctx) => ctx.db.query('instanceSettings').first());
}

async function blobExists(t: Harness, storageId: Id<'_storage'>) {
	return t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null);
}

describe('workspaces.branding.setLogo', () => {
	it('sets the logo and hands its URL to the public pages', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('instanceSettings', { defaultFromName: 'Northwind Studio', createdAt: 1 })
		);
		const storageId = await uploaded(t, PNG);

		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
			mimeType: 'image/png',
		});

		expect((await settingsRow(t))?.logoStorageId).toBe(storageId);
		const logo = await t.query(api.workspaces.branding.get, {});
		expect(logo.logoUrl).toMatch(/^https:\/\//);
		expect(logo.logoDarkUrl).toBeNull();

		const sender = await t.query(api.delivery.unsubscribeQueries.getRecipientSender, {});
		expect(sender).toEqual({
			name: 'Northwind Studio',
			contactEmail: null,
			logoUrl: logo.logoUrl,
			logoDarkUrl: null,
		});
	});

	it('creates the settings row when none exists yet', async () => {
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, SVG);
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
			mimeType: 'image/svg+xml',
		});
		expect((await settingsRow(t))?.logoStorageId).toBe(storageId);
	});

	it('serves the dark logo only alongside a light one', async () => {
		const t = convexTest(schema, modules);
		const dark = await uploaded(t, PNG);
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId: dark,
			variant: 'dark',
			mimeType: 'image/png',
		});
		expect(await t.query(api.workspaces.branding.get, {})).toEqual({
			logoUrl: null,
			logoDarkUrl: null,
		});

		const light = await uploaded(t, SVG);
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId: light,
			variant: 'light',
			mimeType: 'image/svg+xml',
		});
		const logo = await t.query(api.workspaces.branding.get, {});
		expect(logo.logoUrl).not.toBeNull();
		expect(logo.logoDarkUrl).not.toBeNull();
		expect(logo.logoDarkUrl).not.toBe(logo.logoUrl);
	});

	it('refuses members who cannot manage settings', async () => {
		const t = convexTest(schema, modules);
		session.role = 'editor';
		const storageId = await uploaded(t, PNG);
		await expect(
			t.mutation(api.workspaces.branding.setLogo, {
				storageId,
				variant: 'light',
				mimeType: 'image/png',
			})
		).rejects.toThrow(/owners and admins/);
		expect(await settingsRow(t)).toBeNull();
	});

	it('refuses formats other than PNG, JPEG and SVG', async () => {
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, 'GIF89a');
		await expect(
			t.mutation(api.workspaces.branding.setLogo, {
				storageId,
				variant: 'light',
				mimeType: 'image/gif',
			})
		).rejects.toThrow(/PNG, JPEG or SVG/);
	});

	it('refuses a file over the size limit, measured on the stored blob', async () => {
		const t = convexTest(schema, modules);
		const big = new Uint8Array(MAX_WORKSPACE_LOGO_BYTES + 1);
		big.set(PNG);
		const storageId = await uploaded(t, big);
		await expect(
			t.mutation(api.workspaces.branding.setLogo, {
				storageId,
				variant: 'light',
				mimeType: 'image/png',
			})
		).rejects.toThrow(/at most 512 KB/);
	});

	it('refuses a file someone else uploaded', async () => {
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, PNG, 'user-B');
		await expect(
			t.mutation(api.workspaces.branding.setLogo, {
				storageId,
				variant: 'light',
				mimeType: 'image/png',
			})
		).rejects.toThrow(/unclaimed upload/);
	});

	it('deletes the previous file when a logo is replaced', async () => {
		const t = convexTest(schema, modules);
		const first = await uploaded(t, PNG);
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId: first,
			variant: 'light',
			mimeType: 'image/png',
		});
		const second = await uploaded(t, SVG);
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId: second,
			variant: 'light',
			mimeType: 'image/svg+xml',
		});
		expect((await settingsRow(t))?.logoStorageId).toBe(second);
		expect(await blobExists(t, first)).toBe(false);
		expect(await blobExists(t, second)).toBe(true);
	});
});

describe('workspaces.branding.removeLogo', () => {
	it('clears the logo and deletes its file', async () => {
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, PNG);
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
			mimeType: 'image/png',
		});

		await t.mutation(api.workspaces.branding.removeLogo, { variant: 'light' });

		expect((await settingsRow(t))?.logoStorageId).toBeUndefined();
		expect(await blobExists(t, storageId)).toBe(false);
		const sender = await t.query(api.delivery.unsubscribeQueries.getRecipientSender, {});
		expect(sender.logoUrl).toBeNull();
	});

	it('refuses members who cannot manage settings', async () => {
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, PNG);
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
			mimeType: 'image/png',
		});
		session.role = 'editor';
		await expect(
			t.mutation(api.workspaces.branding.removeLogo, { variant: 'light' })
		).rejects.toThrow(/owners and admins/);
		expect((await settingsRow(t))?.logoStorageId).toBe(storageId);
	});
});

describe('workspaces.branding byte check', () => {
	it('keeps a logo whose bytes match its declared type', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, PNG);
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
			mimeType: 'image/png',
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await settingsRow(t))?.logoStorageId).toBe(storageId);
		expect(await blobExists(t, storageId)).toBe(true);
	});

	it('takes down a file that is not the image it claimed to be', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, '<html><script>alert(1)</script></html>');
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
			mimeType: 'image/png',
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await settingsRow(t))?.logoStorageId).toBeUndefined();
		expect(await blobExists(t, storageId)).toBe(false);
	});

	it('takes down an SVG carrying script', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, '<svg><script>alert(1)</script></svg>');
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'dark',
			mimeType: 'image/svg+xml',
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await settingsRow(t))?.logoDarkStorageId).toBeUndefined();
		expect(await blobExists(t, storageId)).toBe(false);
	});

	it('leaves a newer logo alone when an older upload fails the check', async () => {
		const t = convexTest(schema, modules);
		const stale = await uploaded(t, 'not a png');
		const current = await uploaded(t, PNG);
		await t.run((ctx) =>
			ctx.db.insert('instanceSettings', { logoStorageId: current, createdAt: 1 })
		);
		await t.mutation(internal.workspaces.branding.rejectLogo, {
			storageId: stale,
			variant: 'light',
			reason: 'signature',
		});
		expect((await settingsRow(t))?.logoStorageId).toBe(current);
	});
});
