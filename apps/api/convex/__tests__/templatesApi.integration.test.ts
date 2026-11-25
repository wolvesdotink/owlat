/**
 * The template routes of the public API: `/api/v1/transactional-emails` and
 * `/api/v1/saved-blocks`, driven through `t.fetch` so routing, the key gate
 * and the body cap are the real ones.
 *
 * The content scan follows a marker in the HTML, so each case says what it
 * scans. The saved-block rerender pool is stubbed (the component is not
 * registered in convex-test): a propagation is checked on the consumer row it
 * writes and on the rerender it enqueues.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import {
	apiErrorResponseSchema,
	publicOperation,
	reasonsAt,
	successBodySchema,
	type PublicOperationId,
} from '@owlat/public-contract/schemas';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { rateLimiter } from '../lib/rateLimiter';
import { applyTransactionalEmailEdit } from '../transactional/editing';
import { rerenderBlocksPool } from '../emailBlocks/renderingPool';
import type * as EmailScannerModule from '@owlat/email-scanner';

vi.mock('@owlat/email-scanner', async (importOriginal) => {
	const original = await importOriginal<typeof EmailScannerModule>();
	return {
		...original,
		scanContent: vi.fn((_subject: string, html: string) => {
			if (html.includes('BLOCKED-MARKER')) {
				return {
					score: 80,
					pass: false,
					flags: [{ type: 'phishing_url', severity: 'high', description: 'bad link' }],
					level: 'blocked',
				};
			}
			return { score: 0, pass: true, flags: [], level: 'clean' };
		}),
	};
});

vi.mock('../emailBlocks/renderingPool', async () => {
	const actual = await vi.importActual('../emailBlocks/renderingPool');
	return {
		...actual,
		rerenderBlocksPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([p]) =>
			!p.includes('emailBlocks/rendering.ts') &&
			!p.includes('sesActions') &&
			!p.includes('agent/') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('files/processing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider')
	)
);

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
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
async function seedKey(t: T, scopes: string[]): Promise<{ key: string; keyId: Id<'apiKeys'> }> {
	keyCounter += 1;
	const key = `lm_live_${String(keyCounter).padStart(4, '0')}${'k'.repeat(40)}`;
	const keyHash = await hashKey(key);
	const keyId = await t.run(async (ctx) =>
		ctx.db.insert('apiKeys', {
			name: 'templates-key',
			keyHash,
			keyPrefix: 'lm_live_',
			isActive: true,
			scopes,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);
	return { key, keyId };
}

const READ_WRITE = ['templates:read', 'templates:write'];

function request(
	t: T,
	key: string,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {}
) {
	return t.fetch(path, {
		method,
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function expectContractSuccess(operationId: PublicOperationId, res: Response) {
	const operation = publicOperation(operationId);
	expect(res.status).toBe(operation.success.status);
	const body: unknown = await res.clone().json();
	expect(successBodySchema(operation).safeParse(body).error?.issues).toBeUndefined();
}

async function expectRefusal(
	operationId: PublicOperationId,
	res: Response,
	status: number,
	reason: string
): Promise<{ error: { message: string; data: Record<string, unknown> } }> {
	expect(res.status).toBe(status);
	const body = await res.json();
	expect(apiErrorResponseSchema.safeParse(body).error?.issues).toBeUndefined();
	expect(body.error.data?.reason).toBe(reason);
	expect(reasonsAt(publicOperation(operationId), status)).toContain(reason);
	return body;
}

/** A text block as the editor stores it: the renderer validates every field. */
const text = (id: string, html: string) => ({
	id,
	type: 'text',
	content: { html, blockType: 'paragraph', fontSize: 14, textColor: '#374151' },
});

const button = (id: string, label: string, url: string) => ({
	id,
	type: 'button',
	content: {
		text: label,
		url,
		backgroundColor: '#111827',
		textColor: '#ffffff',
		align: 'center',
		borderRadius: 6,
		paddingX: 24,
		paddingY: 12,
	},
});

const EMAIL = {
	name: 'Order confirmation',
	subject: 'Your order {{orderNumber}}',
	blocks: [
		text('b-text', '<p>Thanks for order {{orderNumber}}</p>'),
		button('b-button', 'Track it', 'https://shop.example.com/orders'),
	],
	translations: {
		de: {
			subject: 'Deine Bestellung {{orderNumber}}',
			blocks: { 'b-text': { html: '<p>Danke für Bestellung {{orderNumber}}</p>' } },
		},
	},
	dataVariablesSchema: { orderNumber: 'string' },
};

async function rowBySlug(t: T, slug: string) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('transactionalEmails')
			.withIndex('by_slug', (q) => q.eq('slug', slug))
			.first()
	);
}

async function auditRows(t: T, resourceId: string) {
	return await t.run(async (ctx) =>
		(await ctx.db.query('auditLogs').collect()).filter((row) => row.resourceId === resourceId)
	);
}

const SAVED_ENV = { ...process.env };
beforeEach(() => {
	delete process.env['SITE_URL'];
	process.env['OWLAT_DEV_MODE'] = 'true';
	vi.mocked(rerenderBlocksPool.enqueueAction).mockClear();
});
afterEach(() => {
	process.env = { ...SAVED_ENV };
});

describe('the template routes need a template scope of their own', () => {
	it('refuses a request without a key', async () => {
		const t = setupTest();
		const res = await t.fetch('/api/v1/transactional-emails', { method: 'GET' });
		expect(res.status).toBe(401);
	});

	it('a send key can neither read nor write templates', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, ['transactional:send']);
		const list = await request(t, key, 'GET', '/api/v1/transactional-emails');
		const body = await expectRefusal('listTransactionalEmails', list, 403, 'missing_scope');
		expect(body.error.data['scope']).toBe('templates:read');
		const put = await request(t, key, 'PUT', '/api/v1/transactional-emails/order', EMAIL);
		expect(
			(await expectRefusal('putTransactionalEmail', put, 403, 'missing_scope')).error.data['scope']
		).toBe('templates:write');
	});

	it('a read key cannot write, publish or change a saved block', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, ['templates:read']);
		for (const [operationId, method, path] of [
			['createTransactionalEmail', 'POST', '/api/v1/transactional-emails'],
			['publishTransactionalEmail', 'POST', '/api/v1/transactional-emails/order/publish'],
			['createSavedBlock', 'POST', '/api/v1/saved-blocks'],
		] as const) {
			const res = await request(t, key, method, path, { ...EMAIL, slug: 'order' });
			await expectRefusal(operationId, res, 403, 'missing_scope');
		}
		expect(await rowBySlug(t, 'order')).toBeNull();
	});

	it('answers feature_disabled while transactional emails are off', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				contactCount: 0,
				createdAt: Date.now(),
				featureFlags: { transactional: false },
			});
		});
		const res = await request(t, key, 'GET', '/api/v1/transactional-emails');
		await expectRefusal('listTransactionalEmails', res, 403, 'feature_disabled');
	});
});

describe('POST /api/v1/transactional-emails', () => {
	it('creates a draft through the editor path: sanitised, rendered and audited as the key', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'POST', '/api/v1/transactional-emails', {
			...EMAIL,
			slug: 'order',
			blocks: [text('b-text', '<p>Hi<script>alert(1)</script></p>')],
		});
		await expectContractSuccess('createTransactionalEmail', res);
		const { data } = await res.json();
		expect(data.email).toMatchObject({ slug: 'order', status: 'draft', languages: ['en', 'de'] });
		expect(data.issues.map((issue: { code: string }) => issue.code)).toContain(
			'COMPLIANCE_NO_UNSUBSCRIBE'
		);
		expect(res.headers.get('ETag')).toBe(`"${data.email.revision}"`);

		const row = await rowBySlug(t, 'order');
		expect(row?.content).not.toContain('<script');
		expect(row?.htmlContent).toContain('Hi');
		expect(row?.htmlTranslations).toContain('Danke');
		expect(row?.dataVariablesSchema).toEqual({ orderNumber: 'string' });
		const audit = await auditRows(t, row!._id);
		expect(audit.map((entry) => [entry.action, entry.userId])).toEqual([
			['transactional_email.created', 'api'],
			['transactional_email.updated', 'api'],
		]);
	});

	it('refuses a block with an error, naming it, and stores nothing', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'POST', '/api/v1/transactional-emails', {
			...EMAIL,
			slug: 'order',
			blocks: [button('b-broken', 'Go', '')],
		});
		const body = await expectRefusal('createTransactionalEmail', res, 400, 'invalid_content');
		expect(body.error.data).toMatchObject({ field: 'blocks', blockId: 'b-broken' });
		expect(body.error.data['issues']).toContainEqual(
			expect.objectContaining({ code: 'BUTTON_NO_URL', blockId: 'b-broken', severity: 'error' })
		);
		expect(await rowBySlug(t, 'order')).toBeNull();
	});

	it('refuses a block type the server does not know', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'POST', '/api/v1/transactional-emails', {
			...EMAIL,
			slug: 'order',
			blocks: [{ id: 'b-x', type: 'hologram', content: {} }],
		});
		const body = await expectRefusal('createTransactionalEmail', res, 400, 'invalid_content');
		expect(body.error.data).toMatchObject({ blockId: 'b-x' });
	});

	it.each([
		[{ ...EMAIL, slug: 'order', name: '' }, 'name'],
		[{ ...EMAIL, slug: 'Not A Slug' }, 'slug'],
		[{ ...EMAIL, slug: 'order', blocks: 'nope' }, 'blocks'],
		[
			{ ...EMAIL, slug: 'order', dataVariablesSchema: { total: 'money' } },
			'dataVariablesSchema.total',
		],
		[{ ...EMAIL, slug: 'order', translations: { en: { subject: 'x' } } }, 'translations.en'],
	])('names the field of a malformed body (%#)', async (body, field) => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'POST', '/api/v1/transactional-emails', body);
		expect(res.status).toBe(400);
		expect((await res.json()).error.data?.field).toBe(field);
	});

	it('refuses a slug another email has', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const first = await request(t, key, 'POST', '/api/v1/transactional-emails', {
			...EMAIL,
			slug: 'order',
		});
		expect(first.status).toBe(201);
		const second = await request(t, key, 'POST', '/api/v1/transactional-emails', {
			...EMAIL,
			slug: 'order',
		});
		await expectRefusal('createTransactionalEmail', second, 409, 'slug_taken');
	});

	it('refuses a link to a saved block this instance does not have', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'POST', '/api/v1/transactional-emails', {
			...EMAIL,
			slug: 'order',
			blocks: [
				{
					...text('b-linked', '<p>Footer</p>'),
					savedBlockRef: { blockId: 'k57missing000000000000000000000', blockName: 'Footer' },
				},
			],
		});
		const body = await expectRefusal('createTransactionalEmail', res, 400, 'invalid_content');
		expect(body.error.data).toMatchObject({ blockId: 'b-linked' });
		expect(await rowBySlug(t, 'order')).toBeNull();
	});
});

describe('GET and PUT /api/v1/transactional-emails/{slug}', () => {
	it('a read is an export: putting it back unchanged keeps the content', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const created = await request(t, key, 'PUT', '/api/v1/transactional-emails/order', EMAIL);
		await expectContractSuccess('putTransactionalEmail', created);

		const read = await request(t, key, 'GET', '/api/v1/transactional-emails/order');
		await expectContractSuccess('getTransactionalEmail', read);
		const exported = (await read.json()).data;
		expect(read.headers.get('ETag')).toBe(`"${exported.revision}"`);
		expect(exported).toMatchObject({
			slug: 'order',
			subject: EMAIL.subject,
			blocks: EMAIL.blocks,
			translations: {
				de: { subject: EMAIL.translations.de.subject, blocks: EMAIL.translations.de.blocks },
			},
			dataVariablesSchema: EMAIL.dataVariablesSchema,
		});

		const imported = await request(t, key, 'PUT', '/api/v1/transactional-emails/order', exported);
		await expectContractSuccess('putTransactionalEmail', imported);
		const again = (await imported.json()).data.email;
		const { revision: _a, updatedAt: _b, ...before } = exported;
		const { revision: _c, updatedAt: _d, ...after } = again;
		expect(after).toEqual(before);
		expect(again.revision).toBe(exported.revision + 1);
	});

	it('answers 404 for a slug no email has', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'GET', '/api/v1/transactional-emails/missing');
		expect(res.status).toBe(404);
	});

	it('refuses a write built on a revision someone has edited since', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		await request(t, key, 'PUT', '/api/v1/transactional-emails/order', EMAIL);
		const read = await request(t, key, 'GET', '/api/v1/transactional-emails/order');
		const etag = read.headers.get('ETag')!;

		// An edit in the dashboard after the script read the email.
		await t.run(async (ctx) => {
			const row = (await ctx.db
				.query('transactionalEmails')
				.withIndex('by_slug', (q) => q.eq('slug', 'order'))
				.first())!;
			await applyTransactionalEmailEdit(ctx, row, { subject: 'Edited in the editor' }, 'user_1');
		});

		const res = await request(
			t,
			key,
			'PUT',
			'/api/v1/transactional-emails/order',
			{ ...EMAIL, subject: 'From the script' },
			{ 'If-Match': etag }
		);
		const body = await expectRefusal('putTransactionalEmail', res, 409, 'revision_mismatch');
		expect(body.error.data['currentRevision']).toBe(Number(etag.replaceAll('"', '')) + 1);
		expect((await rowBySlug(t, 'order'))?.subject).toBe('Edited in the editor');

		const current = (await rowBySlug(t, 'order'))!.contentRevision;
		const retried = await request(
			t,
			key,
			'PUT',
			'/api/v1/transactional-emails/order',
			{ ...EMAIL, subject: 'From the script' },
			{ 'If-Match': `"${current}"` }
		);
		expect(retried.status).toBe(200);
	});

	it('names a malformed If-Match', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'PUT', '/api/v1/transactional-emails/order', EMAIL, {
			'If-Match': 'yesterday',
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.data?.field).toBe('If-Match');
	});

	it('refuses a body whose slug differs from the path', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'PUT', '/api/v1/transactional-emails/order', {
			...EMAIL,
			slug: 'other',
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.data?.field).toBe('slug');
	});

	it('changes a published email only when asked to, and scans the change', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		await request(t, key, 'PUT', '/api/v1/transactional-emails/order', EMAIL);
		await request(t, key, 'POST', '/api/v1/transactional-emails/order/publish');

		const refused = await request(t, key, 'PUT', '/api/v1/transactional-emails/order', EMAIL);
		await expectRefusal('putTransactionalEmail', refused, 422, 'email_published');

		const blocked = await request(
			t,
			key,
			'PUT',
			'/api/v1/transactional-emails/order?whilePublished=true',
			{ ...EMAIL, blocks: [text('b-text', '<p>BLOCKED-MARKER</p>')] }
		);
		await expectRefusal('putTransactionalEmail', blocked, 422, 'content_blocked');
		expect((await rowBySlug(t, 'order'))?.content).not.toContain('BLOCKED-MARKER');

		const live = await request(
			t,
			key,
			'PUT',
			'/api/v1/transactional-emails/order?whilePublished=true',
			{ ...EMAIL, subject: 'Live change' }
		);
		expect(live.status).toBe(200);
		expect((await live.json()).data.email).toMatchObject({
			status: 'published',
			subject: 'Live change',
		});
	});

	it('refuses a template write past the key’s write limit, with Retry-After', async () => {
		const t = setupTest();
		const { key, keyId } = await seedKey(t, READ_WRITE);
		await t.run(async (ctx) => {
			await rateLimiter.limit(ctx, 'apiTemplateWrite', { key: keyId, count: 30 });
		});
		const res = await request(t, key, 'PUT', '/api/v1/transactional-emails/order', EMAIL);
		await expectRefusal('putTransactionalEmail', res, 429, 'template_write_rate_limited');
		expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
		expect(await rowBySlug(t, 'order')).toBeNull();
	});
});

describe('publish and unpublish', () => {
	it('publishes through the content scan and audits the key', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		await request(t, key, 'PUT', '/api/v1/transactional-emails/order', EMAIL);
		const res = await request(t, key, 'POST', '/api/v1/transactional-emails/order/publish');
		await expectContractSuccess('publishTransactionalEmail', res);
		expect((await res.json()).data.status).toBe('published');
		const row = (await rowBySlug(t, 'order'))!;
		const audit = await auditRows(t, row._id);
		expect(audit[audit.length - 1]).toMatchObject({
			action: 'transactional_email.published',
			userId: 'api',
		});

		const again = await request(t, key, 'POST', '/api/v1/transactional-emails/order/publish');
		expect(again.status).toBe(200);

		const draft = await request(t, key, 'POST', '/api/v1/transactional-emails/order/unpublish');
		await expectContractSuccess('unpublishTransactionalEmail', draft);
		expect((await draft.json()).data.status).toBe('draft');
	});

	it('refuses to publish content the scan blocks, and the email stays a draft', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		await request(t, key, 'PUT', '/api/v1/transactional-emails/order', {
			...EMAIL,
			blocks: [text('b-text', '<p>BLOCKED-MARKER</p>')],
		});
		const res = await request(t, key, 'POST', '/api/v1/transactional-emails/order/publish');
		const body = await expectRefusal('publishTransactionalEmail', res, 422, 'content_blocked');
		expect(body.error.data['scanScore']).toBe(80);
		expect((await rowBySlug(t, 'order'))?.status).toBe('draft');
	});

	it('answers 404 for another action under the email', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		await request(t, key, 'PUT', '/api/v1/transactional-emails/order', EMAIL);
		const res = await request(t, key, 'POST', '/api/v1/transactional-emails/order/archive');
		expect(res.status).toBe(404);
	});
});

describe('/api/v1/saved-blocks', () => {
	const FOOTER = {
		name: 'Footer',
		description: 'Support link',
		blocks: [text('f-text', '<p>Help: support@example.com</p>')],
	};

	it('creates, reads and lists a saved block', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const created = await request(t, key, 'POST', '/api/v1/saved-blocks', FOOTER);
		await expectContractSuccess('createSavedBlock', created);
		const block = (await created.json()).data.block;
		expect(block).toMatchObject({
			name: 'Footer',
			description: 'Support link',
			blocks: FOOTER.blocks,
		});

		const read = await request(t, key, 'GET', `/api/v1/saved-blocks/${block.id}`);
		await expectContractSuccess('getSavedBlock', read);
		const list = await request(t, key, 'GET', '/api/v1/saved-blocks');
		await expectContractSuccess('listSavedBlocks', list);
		expect((await list.json()).data.map((b: { id: string }) => b.id)).toEqual([block.id]);

		const audit = await auditRows(t, block.id);
		expect(audit[0]).toMatchObject({ action: 'email_block.created', userId: 'api' });
	});

	it('an update reaches the emails that link the block, as an editor edit does', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const block = (await (await request(t, key, 'POST', '/api/v1/saved-blocks', FOOTER)).json())
			.data.block;
		const linked = await request(t, key, 'PUT', '/api/v1/transactional-emails/order', {
			...EMAIL,
			blocks: [
				...EMAIL.blocks,
				{ ...FOOTER.blocks[0]!, savedBlockRef: { blockId: block.id, blockName: 'Footer' } },
			],
		});
		expect(linked.status).toBe(200);
		const before = (await rowBySlug(t, 'order'))!;
		expect(before.linkedBlockIds).toEqual([block.id]);

		const updated = await request(t, key, 'PUT', `/api/v1/saved-blocks/${block.id}`, {
			...FOOTER,
			blocks: [text('f-text', '<p>New support hours</p>')],
		});
		await expectContractSuccess('updateSavedBlock', updated);

		const after = (await rowBySlug(t, 'order'))!;
		expect(after.content).toContain('New support hours');
		expect(after.htmlRenderState?.stale).toBe(true);
		expect(rerenderBlocksPool.enqueueAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			{ templateIds: [], transactionalIds: [before._id] },
			expect.anything()
		);
		const audit = await auditRows(t, block.id);
		expect(audit[audit.length - 1]).toMatchObject({ action: 'email_block.updated', userId: 'api' });
	});

	it('refuses a saved block with a broken block, naming it', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const res = await request(t, key, 'POST', '/api/v1/saved-blocks', {
			...FOOTER,
			blocks: [{ id: 'f-img', type: 'image', content: { src: '' } }],
		});
		const body = await expectRefusal('createSavedBlock', res, 400, 'invalid_content');
		expect(body.error.data).toMatchObject({ blockId: 'f-img' });
	});

	it('answers 404 for an unknown saved block and 400 for a malformed ID', async () => {
		const t = setupTest();
		const { key } = await seedKey(t, READ_WRITE);
		const created = (await (await request(t, key, 'POST', '/api/v1/saved-blocks', FOOTER)).json())
			.data.block;
		await t.run(async (ctx) => ctx.db.delete(created.id as Id<'emailBlocks'>));
		const missing = await request(t, key, 'GET', `/api/v1/saved-blocks/${created.id}`);
		expect(missing.status).toBe(404);
		const update = await request(t, key, 'PUT', `/api/v1/saved-blocks/${created.id}`, FOOTER);
		expect(update.status).toBe(404);
		const malformed = await request(t, key, 'GET', '/api/v1/saved-blocks/nope');
		expect(malformed.status).toBe(400);
		expect((await malformed.json()).error.data?.field).toBe('id');
	});
});
