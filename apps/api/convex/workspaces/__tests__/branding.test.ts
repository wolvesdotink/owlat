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

/**
 * Store bytes the way the upload route does, Content-Type included. The type
 * lands on the `_storage` document in production; convex-test does not record
 * it, so it is written onto the system row here.
 */
async function uploaded(
	t: Harness,
	bytes: Uint8Array | string,
	contentType: string,
	owner = 'user-A'
) {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob([bytes as BlobPart]));
		await (ctx.db as unknown as SystemPatch).patch(storageId, { contentType });
		await recordUploadedBlob(ctx, storageId, owner);
		return storageId;
	});
}
type SystemPatch = {
	patch: (id: Id<'_storage'>, value: { contentType: string }) => Promise<void>;
};

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
		const storageId = await uploaded(t, PNG, 'image/png');

		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
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
		const storageId = await uploaded(t, SVG, 'image/svg+xml');
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
		});
		expect((await settingsRow(t))?.logoStorageId).toBe(storageId);
	});

	it('refuses a dark logo until a main logo is set', async () => {
		const t = convexTest(schema, modules);
		const dark = await uploaded(t, PNG, 'image/png');
		await expect(
			t.mutation(api.workspaces.branding.setLogo, { storageId: dark, variant: 'dark' })
		).rejects.toThrow(/main logo before a dark-mode version/);
		expect(await settingsRow(t)).toBeNull();

		const light = await uploaded(t, SVG, 'image/svg+xml');
		await t.mutation(api.workspaces.branding.setLogo, { storageId: light, variant: 'light' });
		await t.mutation(api.workspaces.branding.setLogo, { storageId: dark, variant: 'dark' });
		const logo = await t.query(api.workspaces.branding.get, {});
		expect(logo.logoUrl).not.toBeNull();
		expect(logo.logoDarkUrl).not.toBeNull();
		expect(logo.logoDarkUrl).not.toBe(logo.logoUrl);
	});

	it('does not serve a stored dark logo without a light one', async () => {
		const t = convexTest(schema, modules);
		const dark = await uploaded(t, PNG, 'image/png');
		await t.run((ctx) =>
			ctx.db.insert('instanceSettings', { logoDarkStorageId: dark, createdAt: 1 })
		);
		expect(await t.query(api.workspaces.branding.get, {})).toEqual({
			logoUrl: null,
			logoDarkUrl: null,
		});
	});

	it('judges the type storage recorded, which is the one the URL serves', async () => {
		const t = convexTest(schema, modules);
		// PNG bytes stored as HTML: the public URL would serve a page.
		const html = await uploaded(t, PNG, 'text/html');
		await expect(
			t.mutation(api.workspaces.branding.setLogo, { storageId: html, variant: 'light' })
		).rejects.toThrow(/PNG, JPEG or SVG/);

		const untyped = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob([PNG as BlobPart]));
			await recordUploadedBlob(ctx, storageId, 'user-A');
			return storageId;
		});
		await expect(
			t.mutation(api.workspaces.branding.setLogo, { storageId: untyped, variant: 'light' })
		).rejects.toThrow(/PNG, JPEG or SVG/);
		expect(await settingsRow(t)).toBeNull();
	});

	it('refuses members who cannot manage settings', async () => {
		const t = convexTest(schema, modules);
		session.role = 'editor';
		const storageId = await uploaded(t, PNG, 'image/png');
		await expect(
			t.mutation(api.workspaces.branding.setLogo, {
				storageId,
				variant: 'light',
			})
		).rejects.toThrow(/owners and admins/);
		expect(await settingsRow(t)).toBeNull();
	});

	it('refuses formats other than PNG, JPEG and SVG', async () => {
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, 'GIF89a', 'image/gif');
		await expect(
			t.mutation(api.workspaces.branding.setLogo, {
				storageId,
				variant: 'light',
			})
		).rejects.toThrow(/PNG, JPEG or SVG/);
	});

	it('refuses a file over the size limit, measured on the stored blob', async () => {
		const t = convexTest(schema, modules);
		const big = new Uint8Array(MAX_WORKSPACE_LOGO_BYTES + 1);
		big.set(PNG);
		const storageId = await uploaded(t, big, 'image/png');
		await expect(
			t.mutation(api.workspaces.branding.setLogo, {
				storageId,
				variant: 'light',
			})
		).rejects.toThrow(/at most 512 KB/);
	});

	it('refuses a file someone else uploaded', async () => {
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, PNG, 'image/png', 'user-B');
		await expect(
			t.mutation(api.workspaces.branding.setLogo, {
				storageId,
				variant: 'light',
			})
		).rejects.toThrow(/unclaimed upload/);
	});

	it('deletes the previous file when a logo is replaced', async () => {
		const t = convexTest(schema, modules);
		const first = await uploaded(t, PNG, 'image/png');
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId: first,
			variant: 'light',
		});
		const second = await uploaded(t, SVG, 'image/svg+xml');
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId: second,
			variant: 'light',
		});
		expect((await settingsRow(t))?.logoStorageId).toBe(second);
		expect(await blobExists(t, first)).toBe(false);
		expect(await blobExists(t, second)).toBe(true);
	});
});

describe('workspaces.branding.removeLogo', () => {
	it('clears the logo and deletes its file', async () => {
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, PNG, 'image/png');
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
		});

		await t.mutation(api.workspaces.branding.removeLogo, { variant: 'light' });

		expect((await settingsRow(t))?.logoStorageId).toBeUndefined();
		expect(await blobExists(t, storageId)).toBe(false);
		const sender = await t.query(api.delivery.unsubscribeQueries.getRecipientSender, {});
		expect(sender.logoUrl).toBeNull();
	});

	it('takes the dark logo with the main one, so no file is left unreachable', async () => {
		const t = convexTest(schema, modules);
		const light = await uploaded(t, PNG, 'image/png');
		const dark = await uploaded(t, SVG, 'image/svg+xml');
		await t.mutation(api.workspaces.branding.setLogo, { storageId: light, variant: 'light' });
		await t.mutation(api.workspaces.branding.setLogo, { storageId: dark, variant: 'dark' });

		await t.mutation(api.workspaces.branding.removeLogo, { variant: 'light' });

		const row = await settingsRow(t);
		expect(row?.logoStorageId).toBeUndefined();
		expect(row?.logoDarkStorageId).toBeUndefined();
		expect(await blobExists(t, light)).toBe(false);
		expect(await blobExists(t, dark)).toBe(false);

		// A later main logo does not bring the old dark one back.
		const next = await uploaded(t, PNG, 'image/png');
		await t.mutation(api.workspaces.branding.setLogo, { storageId: next, variant: 'light' });
		expect((await t.query(api.workspaces.branding.get, {})).logoDarkUrl).toBeNull();
	});

	it('removes only the dark logo when that is the one asked for', async () => {
		const t = convexTest(schema, modules);
		const light = await uploaded(t, PNG, 'image/png');
		const dark = await uploaded(t, SVG, 'image/svg+xml');
		await t.mutation(api.workspaces.branding.setLogo, { storageId: light, variant: 'light' });
		await t.mutation(api.workspaces.branding.setLogo, { storageId: dark, variant: 'dark' });

		await t.mutation(api.workspaces.branding.removeLogo, { variant: 'dark' });

		const row = await settingsRow(t);
		expect(row?.logoStorageId).toBe(light);
		expect(row?.logoDarkStorageId).toBeUndefined();
		expect(await blobExists(t, light)).toBe(true);
		expect(await blobExists(t, dark)).toBe(false);
	});

	it('refuses members who cannot manage settings', async () => {
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, PNG, 'image/png');
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
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
		const storageId = await uploaded(t, PNG, 'image/png');
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await settingsRow(t))?.logoStorageId).toBe(storageId);
		expect(await blobExists(t, storageId)).toBe(true);
	});

	it('takes down a file that is not the image it claimed to be', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const storageId = await uploaded(t, '<html><script>alert(1)</script></html>', 'image/png');
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'light',
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await settingsRow(t))?.logoStorageId).toBeUndefined();
		expect(await blobExists(t, storageId)).toBe(false);
	});

	it('takes down an SVG carrying script', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const light = await uploaded(t, PNG, 'image/png');
		await t.run((ctx) => ctx.db.insert('instanceSettings', { logoStorageId: light, createdAt: 1 }));
		const storageId = await uploaded(t, '<svg><script>alert(1)</script></svg>', 'image/svg+xml');
		await t.mutation(api.workspaces.branding.setLogo, {
			storageId,
			variant: 'dark',
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await settingsRow(t))?.logoDarkStorageId).toBeUndefined();
		expect((await settingsRow(t))?.logoStorageId).toBe(light);
		expect(await blobExists(t, storageId)).toBe(false);
	});

	it('leaves a newer logo alone when an older upload fails the check', async () => {
		const t = convexTest(schema, modules);
		const stale = await uploaded(t, 'not a png', 'image/png');
		const current = await uploaded(t, PNG, 'image/png');
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
