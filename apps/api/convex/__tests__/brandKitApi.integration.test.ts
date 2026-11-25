/**
 * `/api/v1/brand-kit`, driven through `t.fetch` so routing and the key gate are
 * the real ones, against the dashboard's own read and write of the kit
 * (`workspaces/brandKit.ts`), which the API shares its write path with.
 */

import { convexTest } from 'convex-test';
import { ConvexError, type Value } from 'convex/values';
import { describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import {
	apiErrorResponseSchema,
	publicOperation,
	reasonsAt,
	successBodySchema,
	type PublicOperationId,
} from '@owlat/public-contract/schemas';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { loadEmailTheme } from '../lib/publishableEmailRender';
import { modules } from './testModules';
import { setSession } from './threadedSessionMock';
import { openWorkspaceDeletionFence } from './helpers/workspaceDeletionFence';

vi.mock('../lib/sessionOrganization', async () => {
	const { threadedSessionMock } = await import('./threadedSessionMock');
	return await threadedSessionMock();
});

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	setSession('admin-user', 'owner');
	return t;
}
type T = ReturnType<typeof setupTest>;

async function hashKey(k: string): Promise<string> {
	const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k));
	return Array.from(new Uint8Array(h))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

let keyCounter = 0;
async function seedKey(t: T, scopes: string[]): Promise<string> {
	keyCounter += 1;
	const key = `lm_live_${String(keyCounter).padStart(4, '0')}${'b'.repeat(40)}`;
	const keyHash = await hashKey(key);
	await t.run(async (ctx) =>
		ctx.db.insert('apiKeys', {
			name: 'brand-kit-key',
			keyHash,
			keyPrefix: 'lm_live_',
			isActive: true,
			scopes,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);
	return key;
}

const READ_WRITE = ['brand-kit:read', 'brand-kit:write'];

function request(t: T, key: string, method: string, body?: unknown) {
	return t.fetch('/api/v1/brand-kit', {
		method,
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function expectContractSuccess(operationId: PublicOperationId, res: Response) {
	const operation = publicOperation(operationId);
	expect(res.status).toBe(operation.success.status);
	const body: unknown = await res.clone().json();
	expect(successBodySchema(operation).safeParse(body).error?.issues).toBeUndefined();
}

async function expectInvalidField(res: Response, field: string) {
	expect(res.status).toBe(400);
	const body = await res.json();
	expect(apiErrorResponseSchema.safeParse(body).error?.issues).toBeUndefined();
	expect(body.error.category).toBe('invalid_input');
	expect(body.error.data?.field).toBe(field);
	return body;
}

/** What the dashboard saves from its brand kit form: every field, logos included. */
const DASHBOARD_KIT = {
	primaryColor: '#c4785a',
	secondaryColor: '#282d3a',
	textColor: '#374151',
	backgroundColor: '#ffffff',
	linkColor: '#2563eb',
	swatches: ['#F59E0B'],
	headingFontFamily: 'Georgia, serif',
	bodyFontFamily: 'Arial, sans-serif',
	buttonRadius: 8,
	buttonPaddingX: 24,
	buttonPaddingY: 12,
	baseWidth: 600,
	footerCompanyName: 'Example Shop GmbH',
	footerAddress: '1 Example Street',
	footerSocialLinks: [{ platform: 'github' as const, url: 'https://github.com/example' }],
};

async function seedLogo(t: T): Promise<Id<'mediaAssets'>> {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(['logo'], { type: 'image/png' }));
		return await ctx.db.insert('mediaAssets', {
			storageId,
			filename: 'logo.png',
			mimeType: 'image/png',
			fileSize: 4,
			url: 'https://files.owlat.example/logo.png',
			width: 160,
			tags: ['brand-kit'],
			uploadedBy: 'admin-user',
			searchableText: 'logo.png',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function settingsAudit(t: T) {
	return await t.run(async (ctx) =>
		(await ctx.db.query('auditLogs').collect()).filter((row) => row.action === 'settings.updated')
	);
}

describe('GET /api/v1/brand-kit', () => {
	it('needs brand-kit:read; a template key is refused', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['templates:read', 'templates:write']);
		const res = await request(t, key, 'GET');
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.data).toMatchObject({ reason: 'missing_scope', scope: 'brand-kit:read' });
		expect(reasonsAt(publicOperation('getBrandKit'), 403)).toContain('missing_scope');
	});

	it('answers what the dashboard reads, the logo resolved to its URL', async () => {
		const t = setupTest();
		const logo = await seedLogo(t);
		await t.mutation(api.workspaces.brandKit.update, { ...DASHBOARD_KIT, logoMediaAssetId: logo });
		const key = await seedKey(t, ['brand-kit:read']);

		const res = await request(t, key, 'GET');
		await expectContractSuccess('getBrandKit', res);
		const { data } = await res.json();
		const dashboard = await t.query(api.workspaces.brandKit.get, {});
		expect(data).toEqual({
			...dashboard.design,
			logo: { url: 'https://files.owlat.example/logo.png', width: 160 },
			logoDark: null,
		});
		expect(data).toMatchObject({ isConfigured: true, swatches: ['#f59e0b'] });
	});

	it('answers the defaults, unconfigured, before anyone saved the kit', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['brand-kit:read']);
		const res = await request(t, key, 'GET');
		await expectContractSuccess('getBrandKit', res);
		const { data } = await res.json();
		expect(data).toMatchObject({ isConfigured: false, logo: null, logoDark: null });
	});
});

describe('PUT /api/v1/brand-kit', () => {
	it('needs brand-kit:write; a read key changes nothing', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['brand-kit:read']);
		const res = await request(t, key, 'PUT', { primaryColor: '#000000' });
		expect(res.status).toBe(403);
		expect((await res.json()).error.data).toMatchObject({
			reason: 'missing_scope',
			scope: 'brand-kit:write',
		});
		expect((await t.query(api.workspaces.brandKit.get, {})).design.isConfigured).toBe(false);
	});

	it('writes nothing for a body that names no field', async () => {
		const t = setupTest();
		const key = await seedKey(t, ['brand-kit:write']);
		const res = await request(t, key, 'PUT', {});
		await expectContractSuccess('updateBrandKit', res);
		expect((await res.json()).data.isConfigured).toBe(false);
		expect((await t.query(api.workspaces.brandKit.get, {})).design.isConfigured).toBe(false);
		expect(await settingsAudit(t)).toHaveLength(0);
	});

	it('changes the fields it names, keeps the rest and the logo, and the dashboard reads the result', async () => {
		const t = setupTest();
		const logo = await seedLogo(t);
		await t.mutation(api.workspaces.brandKit.update, { ...DASHBOARD_KIT, logoMediaAssetId: logo });
		const key = await seedKey(t, READ_WRITE);

		const res = await request(t, key, 'PUT', {
			headingFontFamily: "'Montserrat', Arial, sans-serif",
			footerAddress: '  2 Example Road\n12345 Example City  ',
		});
		await expectContractSuccess('updateBrandKit', res);
		const { data } = await res.json();

		const dashboard = await t.query(api.workspaces.brandKit.get, {});
		expect(dashboard.design).toEqual({
			...DASHBOARD_KIT,
			isConfigured: true,
			swatches: ['#f59e0b'],
			headingFontFamily: "'Montserrat', Arial, sans-serif",
			footerAddress: '2 Example Road\n12345 Example City',
		});
		expect(dashboard.logos.light?.mediaAssetId).toBe(logo);
		expect(data).toEqual({
			...dashboard.design,
			logo: { url: 'https://files.owlat.example/logo.png', width: 160 },
			logoDark: null,
		});
		// The web font the heading stack names reaches the server render's theme.
		const theme = await t.run((ctx) => loadEmailTheme(ctx));
		expect(theme?.fontUrls).toEqual([expect.stringContaining('family=Montserrat')]);

		const audit = await settingsAudit(t);
		expect(audit.map((row) => row.userId)).toEqual(['admin-user', 'api']);
	});

	it('refuses a colour the brand kit page would refuse, naming the field, and stores nothing', async () => {
		const t = setupTest();
		const key = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'PUT', { footerCompanyName: 'Kept out', linkColor: 'blue' });
		const body = await expectInvalidField(res, 'linkColor');
		expect(body.error.message).toBe('Every brand colour must be a hex colour such as #c4785a');
		const dashboard = await t.query(api.workspaces.brandKit.get, {});
		expect(dashboard.design).toMatchObject({ isConfigured: false, footerCompanyName: '' });
	});

	it('refuses a font the brand kit does not offer, naming the field', async () => {
		const t = setupTest();
		const key = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'PUT', { bodyFontFamily: "'Comic Neue', cursive" });
		await expectInvalidField(res, 'bodyFontFamily');
	});

	it('refuses an unknown field by name instead of ignoring it', async () => {
		const t = setupTest();
		const key = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'PUT', { headingFont: "'Inter', Arial, sans-serif" });
		const body = await expectInvalidField(res, 'headingFont');
		expect(body.error.message).toBe('Unknown field headingFont');
		expect((await t.query(api.workspaces.brandKit.get, {})).design.isConfigured).toBe(false);
	});

	it.each(['logo', 'logoMediaAssetId'])('refuses %s: the API cannot set a logo', async (field) => {
		const t = setupTest();
		const logo = await seedLogo(t);
		const key = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'PUT', { primaryColor: '#000000', [field]: logo });
		const body = await expectInvalidField(res, field);
		expect(body.error.message).toContain('brand kit page');
		const dashboard = await t.query(api.workspaces.brandKit.get, {});
		expect(dashboard.design.isConfigured).toBe(false);
		expect(dashboard.logos.light).toBeNull();
	});

	it('refuses a field of the wrong type, naming it', async () => {
		const t = setupTest();
		const key = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'PUT', { buttonRadius: '8' });
		await expectInvalidField(res, 'buttonRadius');
	});

	it('keeps the invalid_state (422) of a write refused by the deletion fence', async () => {
		const t = setupTest();
		const key = await seedKey(t, READ_WRITE);
		await t.run((ctx) => openWorkspaceDeletionFence(ctx));
		const res = await request(t, key, 'PUT', { primaryColor: '#000000' });
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(apiErrorResponseSchema.safeParse(body).error?.issues).toBeUndefined();
		expect(body.error).toMatchObject({
			category: 'invalid_state',
			data: { reason: 'workspace_deletion_in_progress' },
		});
		expect(reasonsAt(publicOperation('updateBrandKit'), 422)).toContain(
			'workspace_deletion_in_progress'
		);
	});
});

describe('the dashboard write, through the shared path', () => {
	it('names the field at fault too', async () => {
		const t = setupTest();
		const error = await t
			.mutation(api.workspaces.brandKit.update, { ...DASHBOARD_KIT, buttonPaddingY: 99 })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ConvexError);
		expect((error as ConvexError<Value>).data).toMatchObject({
			category: 'invalid_input',
			data: { field: 'buttonPaddingY' },
		});
	});
});
