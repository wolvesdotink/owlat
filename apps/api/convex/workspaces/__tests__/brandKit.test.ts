/**
 * Brand kit (`workspaces/brandKit.ts`): owners and admins save it, every
 * reader resolves it the same way, the server render projects it, and new
 * emails start from it.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { loadEmailTheme } from '../../lib/publishableEmailRender';

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
	requireOrgPermission: vi.fn(async () => ({ ...session })),
	getUserIdFromSession: vi.fn(async () => session.userId),
	isActiveOrgMember: vi.fn(async () => true),
}));

// Vite keys siblings in this subtree as '../X', which convex-test would never
// match (see settings.test.ts).
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

beforeEach(() => {
	session.userId = 'user-A';
	session.role = 'owner';
});

const KIT = {
	primaryColor: '#0f766e',
	secondaryColor: '#94a3b8',
	textColor: '#1f2937',
	backgroundColor: '#ffffff',
	linkColor: '#0369a1',
	swatches: ['#FACC15'],
	headingFontFamily: 'Georgia, serif',
	bodyFontFamily: "'Inter', Arial, sans-serif",
	buttonRadius: 20,
	buttonPaddingX: 24,
	buttonPaddingY: 12,
	baseWidth: 600,
	footerCompanyName: '  Northwind  ',
	footerAddress: '1 Example Street',
	footerSocialLinks: [{ platform: 'github' as const, url: 'https://github.com/example' }],
};

async function mediaImage(t: Harness, tags?: string[]): Promise<Id<'mediaAssets'>> {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(['png']));
		return ctx.db.insert('mediaAssets', {
			storageId,
			filename: 'logo.png',
			mimeType: 'image/png',
			fileSize: 3,
			width: 240,
			url: 'https://files.example.com/logo.png',
			uploadedBy: 'user-A',
			...(tags ? { tags } : {}),
			createdAt: 1,
			updatedAt: 1,
		});
	});
}

describe('workspaces.brandKit.get', () => {
	it('is the unconfigured defaults on a fresh instance', async () => {
		const t = convexTest(schema, modules);
		const kit = await t.query(api.workspaces.brandKit.get, {});
		expect(kit.design.isConfigured).toBe(false);
		expect(kit.logos).toEqual({ light: null, dark: null });
	});

	it('reads the email theme an older page saved', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('instanceSettings', {
				emailTheme: {
					primaryColor: '#123456',
					fontFamily: 'Georgia, serif',
					backgroundColor: '#fafafa',
				},
				createdAt: 1,
				updatedAt: 1,
			})
		);
		const { design } = await t.query(api.workspaces.brandKit.get, {});
		expect(design).toMatchObject({
			isConfigured: false,
			primaryColor: '#123456',
			bodyFontFamily: 'Georgia, serif',
			backgroundColor: '#fafafa',
		});
	});
});

describe('workspaces.brandKit.update', () => {
	it('saves both columns, normalized, with an audit row, and resolves the logos', async () => {
		const t = convexTest(schema, modules);
		const light = await mediaImage(t);
		const dark = await mediaImage(t);
		await t.mutation(api.workspaces.brandKit.update, {
			...KIT,
			logoMediaAssetId: light,
			logoDarkMediaAssetId: dark,
		});

		const row = await t.run((ctx) => ctx.db.query('instanceSettings').first());
		expect(row?.emailTheme).toEqual({
			primaryColor: '#0f766e',
			fontFamily: "'Inter', Arial, sans-serif",
			backgroundColor: '#ffffff',
			baseWidth: 600,
		});
		expect(row?.brandKit).toMatchObject({
			swatches: ['#facc15'],
			footerCompanyName: 'Northwind',
			logoMediaAssetId: light,
			logoDarkMediaAssetId: dark,
		});
		const audit = await t.run((ctx) => ctx.db.query('auditLogs').first());
		expect(audit?.action).toBe('settings.updated');

		const kit = await t.query(api.workspaces.brandKit.get, {});
		expect(kit.design.isConfigured).toBe(true);
		expect(kit.logos.light).toEqual({
			url: 'https://files.example.com/logo.png',
			storageId: expect.any(String),
			mediaAssetId: light,
			width: 240,
		});
		expect(kit.logos.dark?.mediaAssetId).toBe(dark);

		// A logo deleted from the media library reads as no logo.
		await t.run((ctx) => ctx.db.delete(light));
		expect((await t.query(api.workspaces.brandKit.get, {})).logos).toEqual({
			light: null,
			dark: null,
		});
	});

	it('is refused to an editor', async () => {
		const t = convexTest(schema, modules);
		session.role = 'editor';
		await expect(t.mutation(api.workspaces.brandKit.update, KIT)).rejects.toThrow(
			/Only owners and admins can change the brand kit/
		);
	});

	it('refuses an invalid colour, an unknown font and an unsafe social link', async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(api.workspaces.brandKit.update, { ...KIT, textColor: 'blue' })
		).rejects.toThrow(/hex colour/);
		await expect(
			t.mutation(api.workspaces.brandKit.update, { ...KIT, bodyFontFamily: 'Comic Sans MS' })
		).rejects.toThrow(/fonts/);
		await expect(
			t.mutation(api.workspaces.brandKit.update, {
				...KIT,
				footerSocialLinks: [{ platform: 'github', url: 'javascript:alert(1)' }],
			})
		).rejects.toThrow(/social link/);
	});

	it('refuses a dark logo without a main one, and a chat attachment as a logo', async () => {
		const t = convexTest(schema, modules);
		const dark = await mediaImage(t);
		await expect(
			t.mutation(api.workspaces.brandKit.update, { ...KIT, logoDarkMediaAssetId: dark })
		).rejects.toThrow(/main logo/);
		const chat = await mediaImage(t, ['chat-attachment']);
		await expect(
			t.mutation(api.workspaces.brandKit.update, { ...KIT, logoMediaAssetId: chat })
		).rejects.toThrow(/media library/);
	});
});

describe('the brand kit in rendering and new emails', () => {
	it('loadEmailTheme projects the saved kit', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.workspaces.brandKit.update, KIT);
		const theme = await t.run((ctx) => loadEmailTheme(ctx));
		expect(theme).toMatchObject({
			primaryColor: '#0f766e',
			bodyTextColor: '#1f2937',
			headingFontFamily: 'Georgia, serif',
			fontUrls: [expect.stringContaining('family=Inter')],
		});
	});

	it('a blank template starts with the logo and footer; a preset is restyled', async () => {
		const t = convexTest(schema, modules);
		const logo = await mediaImage(t);
		await t.mutation(api.workspaces.brandKit.update, { ...KIT, logoMediaAssetId: logo });

		const blankId = await t.mutation(api.emailTemplates.emails.create, {
			name: 'Blank',
			type: 'marketing',
		});
		const blank = await t.run((ctx) => ctx.db.get(blankId));
		expect(
			(JSON.parse(blank!.content) as Array<{ type: string }>).map((block) => block.type)
		).toEqual(['image', 'text', 'social']);

		const preset = JSON.stringify([
			{
				id: 'p1',
				type: 'button',
				content: { text: 'Go', url: 'https://example.com', backgroundColor: '#ff0000' },
			},
		]);
		const presetId = await t.mutation(api.emailTemplates.organization.createFromPreset, {
			name: 'Preset',
			subject: 'Hi',
			content: preset,
			type: 'marketing',
		});
		const created = await t.run((ctx) => ctx.db.get(presetId));
		expect(JSON.parse(created!.content)[0].content).toMatchObject({
			text: 'Go',
			backgroundColor: '#0f766e',
			borderRadius: 20,
		});
	});

	it('a blank template stays blank without a saved kit', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.emailTemplates.emails.create, {
			name: 'Blank',
			type: 'marketing',
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.content).toBe('[]');
	});

	it('the media library counts the brand kit logo as a use', async () => {
		const t = convexTest(schema, modules);
		const logo = await mediaImage(t);
		expect(await t.query(api.mediaAssets.countUsage, { assetId: logo })).toEqual({ count: 0 });
		await t.mutation(api.workspaces.brandKit.update, { ...KIT, logoMediaAssetId: logo });
		expect(await t.query(api.mediaAssets.countUsage, { assetId: logo })).toEqual({ count: 1 });
	});
});

describe('workspaces.brandKit.registerFetchedImage', () => {
	it('adds the fetched image to the media library and binds the blob to it', async () => {
		const t = convexTest(schema, modules);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]))
		);
		const asset = await t.mutation(internal.workspaces.brandKit.registerFetchedImage, {
			storageId,
			filename: 'example.com-logo.png',
			mimeType: 'image/png',
			userId: 'user-A',
			organizationId: 'org-1',
		});
		const row = await t.run((ctx) => ctx.db.get(asset.mediaAssetId));
		expect(row).toMatchObject({ filename: 'example.com-logo.png', tags: ['brand-kit'] });
		const receipt = await t.run((ctx) =>
			ctx.db
				.query('storageUploads')
				.withIndex('by_storage', (q) => q.eq('storageId', storageId))
				.unique()
		);
		expect(receipt).toMatchObject({
			status: 'bound',
			resourceKey: `mediaAssets:${asset.mediaAssetId}`,
		});
	});

	it('refuses a type the media library does not take', async () => {
		const t = convexTest(schema, modules);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])));
		await expect(
			t.mutation(internal.workspaces.brandKit.registerFetchedImage, {
				storageId,
				filename: 'page.html',
				mimeType: 'text/html',
				userId: 'user-A',
				organizationId: 'org-1',
			})
		).rejects.toThrow(/not allowed/);
	});
});
