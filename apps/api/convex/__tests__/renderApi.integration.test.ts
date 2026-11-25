/**
 * `POST /api/v1/render` and the dry run of `POST /api/v1/transactional`,
 * driven through `t.fetch` so routing, the key gate and the body cap are the
 * real ones.
 *
 * Both claim to answer what the instance would really store and send, so the
 * cases compare them byte for byte with a save through the editor's path and
 * with the message the worker composes for a real send. The workpool is
 * stubbed: a real send is checked on the envelope it enqueues.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import {
	apiErrorResponseSchema,
	dryRunBodySchema,
	publicOperation,
	reasonsAt,
	successBodySchema,
	type PublicOperationId,
} from '@owlat/public-contract/schemas';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { rateLimiter } from '../lib/rateLimiter';
import { readInstanceCounter } from '../lib/instanceCounters';
import { applyTransactionalEmailEdit } from '../transactional/editing';
import {
	PER_API_KEY_DAILY_BUCKET,
	PER_API_KEY_DAILY_CONFIG,
	PER_RECIPIENT_BUCKET,
	perRecipientConfig,
	perRecipientKey,
	readBucketUsage,
} from '../transactional/sendCaps';
import { effectiveSendCaps } from '../transactional/sendCapsPolicy';
import { transactionalEmailPool } from '../delivery/workpool';
import { composeForSend } from '../delivery/sendComposition';
import { buildComposeInput } from '../delivery/worker';
import { createTestBlockedEmail, createTestDomain, createTestInstanceSettings } from './factories';
import type * as EmailScannerModule from '@owlat/email-scanner';
import type * as SessionOrganization from '../lib/sessionOrganization';

vi.mock('@owlat/email-scanner', async (importOriginal) => {
	const original = await importOriginal<typeof EmailScannerModule>();
	return {
		...original,
		scanContent: vi.fn(() => ({ score: 0, pass: true, flags: [], level: 'clean' })),
	};
});

vi.mock('../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
}));

// The organization an Idempotency-Key is scoped to (the BetterAuth component
// is not registered in this harness).
vi.mock('../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof SessionOrganization>();
	return { ...actual, getSingletonOrganizationId: vi.fn(async () => 'org-a') };
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([p]) =>
			!p.includes('emailBlocks/rendering.ts') &&
			!p.includes('sesActions') &&
			!p.includes('posthog') &&
			!p.includes('delivery/worker.ts') &&
			!p.includes('delivery/workpool') &&
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
	const key = `lm_live_${String(keyCounter).padStart(4, '0')}${'r'.repeat(40)}`;
	const keyHash = await hashKey(key);
	const keyId = await t.run(async (ctx) =>
		ctx.db.insert('apiKeys', {
			name: 'render-key',
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

async function renderOk(res: Response) {
	const operation = publicOperation('renderEmail');
	expect(res.status).toBe(operation.success.status);
	const body: unknown = await res.clone().json();
	expect(successBodySchema(operation).safeParse(body).error?.issues).toBeUndefined();
	return (await res.json()).data;
}

async function dryRunOk(res: Response) {
	expect(res.status).toBe(200);
	const body: unknown = await res.clone().json();
	const schema = dryRunBodySchema(publicOperation('sendTransactional'))!;
	expect(schema.safeParse(body).error?.issues).toBeUndefined();
	return (await res.json()).data;
}

// ─── The fixture: a condition, a repeat, a preview text and a translation ───

const text = (id: string, html: string, logic: Record<string, unknown> = {}) => ({
	id,
	type: 'text',
	content: { html, blockType: 'paragraph', fontSize: 14, textColor: '#374151', ...logic },
});

const BLOCKS = [
	text('b-intro', '<p>Hi {{firstName}}, thanks for order {{orderNumber}}</p>'),
	text('b-code', '<p>Your booking code is {{bookingCode}}</p>', {
		condition: { variable: 'bookingCode', operator: 'exists' },
	}),
	text('b-line', '<p>{{item.name}} x {{item.qty}}</p>', {
		repeat: { variable: 'items', itemAlias: 'item' },
	}),
	{
		id: 'b-button',
		type: 'button',
		content: {
			text: 'Track it',
			url: 'https://shop.example.com/orders',
			backgroundColor: '#111827',
			textColor: '#ffffff',
			align: 'center',
			borderRadius: 6,
			paddingX: 24,
			paddingY: 12,
		},
	},
];

const TRANSLATIONS = {
	de: {
		subject: 'Deine Bestellung {{orderNumber}}',
		blocks: {
			'b-intro': { html: '<p>Hallo {{firstName}}, danke für Bestellung {{orderNumber}}</p>' },
		},
	},
};

const SUBJECT = 'Your order {{orderNumber}}';
const PREVIEW_TEXT = "  Arriving {{deliveryDay|'soon'}}  ";
const VARIABLES_SCHEMA = {
	firstName: 'string',
	orderNumber: 'string',
	bookingCode: 'string',
	items: 'array',
} as const;

const EMAIL = {
	name: 'Order confirmation',
	subject: SUBJECT,
	blocks: BLOCKS,
	translations: TRANSLATIONS,
	dataVariablesSchema: VARIABLES_SCHEMA,
};

const RENDER = {
	subject: SUBJECT,
	previewText: PREVIEW_TEXT,
	blocks: BLOCKS,
	translations: TRANSLATIONS,
	dataVariablesSchema: VARIABLES_SCHEMA,
};

const DATA = {
	firstName: 'Ada',
	orderNumber: 'A-1001',
	bookingCode: 'BK-42',
	items: [
		{ name: 'Lamp', qty: 1 },
		{ name: 'Bulb', qty: 3 },
	],
};

const ALL = ['templates:read', 'templates:write', 'transactional:send'];

async function seedSendable(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				abuseStatus: 'clean',
				defaultFromEmail: 'noreply@example.com',
				defaultFromName: 'Owlat',
				emailTheme: { primaryColor: '#0f766e', fontFamily: 'Georgia', backgroundColor: '#fafaf9' },
			})
		);
		await ctx.db.insert(
			'domains',
			createTestDomain({ domain: 'example.com', status: 'verified', lastVerifiedAt: Date.now() })
		);
	});
}

/** Store the fixture as `order` through the API's write, with its preview text set in the editor. */
async function saveOrder(t: T, key: string) {
	const put = await request(t, key, 'PUT', '/api/v1/transactional-emails/order', EMAIL);
	expect(put.status).toBe(200);
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query('transactionalEmails')
			.withIndex('by_slug', (q) => q.eq('slug', 'order'))
			.first();
		await applyTransactionalEmailEdit(ctx, row!, { previewText: PREVIEW_TEXT }, 'test-user');
	});
	return (await t.run(async (ctx) =>
		ctx.db
			.query('transactionalEmails')
			.withIndex('by_slug', (q) => q.eq('slug', 'order'))
			.first()
	))!;
}

async function publishOrder(t: T, key: string) {
	const res = await request(t, key, 'POST', '/api/v1/transactional-emails/order/publish');
	expect(res.status).toBe(200);
}

/** What the worker composes for the send the last real request enqueued. */
function lastSentMessage() {
	const calls = vi.mocked(transactionalEmailPool.enqueueAction).mock.calls;
	const queued = calls[calls.length - 1]?.[2] as {
		envelopeInput: Parameters<typeof buildComposeInput>[0];
	};
	return composeForSend(buildComposeInput(queued.envelopeInput));
}

/** Everything a send writes or schedules, to show a dry run touched none of it. */
async function sendFootprint(t: T, templateId: Id<'transactionalEmails'>, keyId: Id<'apiKeys'>) {
	return await t.run(async (ctx) => {
		const caps = effectiveSendCaps(undefined);
		const now = Date.now();
		return {
			sends: (await ctx.db.query('transactionalSends').collect()).length,
			contacts: (await ctx.db.query('contacts').collect()).length,
			receipts: (await ctx.db.query('apiRequestReceipts').collect()).length,
			audit: (await ctx.db.query('auditLogs').collect()).length,
			scheduled: (await ctx.db.system.query('_scheduled_functions').collect()).length,
			counters: await readInstanceCounter(ctx.db, 'sends'),
			sendCount: (await ctx.db.get(templateId))?.sendCount ?? 0,
			recipientCap: (
				await readBucketUsage(
					ctx,
					PER_RECIPIENT_BUCKET,
					perRecipientKey(templateId, 'ada@example.com'),
					perRecipientConfig(caps.perRecipient.count, caps.perRecipient.windowMs),
					now
				)
			).used,
			dailyCap: (
				await readBucketUsage(ctx, PER_API_KEY_DAILY_BUCKET, keyId, PER_API_KEY_DAILY_CONFIG, now)
			).used,
		};
	});
}

const SAVED_ENV = { ...process.env };
beforeEach(() => {
	delete process.env['SITE_URL'];
	process.env['OWLAT_DEV_MODE'] = 'true';
	process.env['EMAIL_PROVIDER'] = 'mta';
	process.env['MTA_API_URL'] = 'http://mta.internal.example';
	process.env['MTA_API_KEY'] = 'mta-key';
	vi.mocked(transactionalEmailPool.enqueueAction).mockClear();
});
afterEach(() => {
	process.env = { ...SAVED_ENV };
});

// ─── POST /api/v1/render ─────────────────────────────────────────────────────

describe('POST /api/v1/render', () => {
	it('answers byte for byte what a save stores, in every language', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ALL);
		const row = await saveOrder(t, key);

		const en = await renderOk(await request(t, key, 'POST', '/api/v1/render', RENDER));
		expect(en).toMatchObject({ kind: 'transactional', language: 'en', composed: false });
		expect(en.html).toBe(row.htmlContent);
		expect(en.text).toBe(row.plainTextContent);
		expect(en.subject).toBe(row.subject);
		// The instance's theme and the preview text are in what both stored.
		expect(en.html).toContain('#fafaf9');
		expect(en.html).toContain('Arriving');

		const de = await renderOk(
			await request(t, key, 'POST', '/api/v1/render', { ...RENDER, language: 'de' })
		);
		const stored = JSON.parse(row.htmlTranslations!).de;
		expect(de.language).toBe('de');
		expect(de.html).toBe(stored.htmlContent);
		expect(de.subject).toBe(stored.subject);
		expect(de.text).toBeNull();
	});

	it('composes with sample data exactly as a real send of the stored email does', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ALL);
		await saveOrder(t, key);
		await publishOrder(t, key);

		for (const [language, data] of [
			['en', DATA],
			['de', DATA],
			['en', { ...DATA, bookingCode: null, items: [] }],
		] as const) {
			const rendered = await renderOk(
				await request(t, key, 'POST', '/api/v1/render', {
					...RENDER,
					language,
					dataVariables: data,
				})
			);
			const sent = await request(t, key, 'POST', '/api/v1/transactional', {
				email: 'ada@example.com',
				slug: 'order',
				language,
				dataVariables: data,
			});
			expect(sent.status).toBe(202);
			const message = lastSentMessage();
			expect(rendered.composed).toBe(true);
			expect(rendered.html).toBe(message.html);
			expect(rendered.text).toBe(message.text);
			expect(rendered.subject).toBe(message.subject);
			expect(rendered.sendRefusal).toBeNull();
		}
		const withCode = await renderOk(
			await request(t, key, 'POST', '/api/v1/render', { ...RENDER, dataVariables: DATA })
		);
		expect(withCode.html).toContain('Your booking code is BK-42');
		expect(withCode.html).toContain('Bulb x 3');
		expect(withCode.html).not.toContain('owlat:');
	});

	it('reports missing and mistyped variables the way the send route refuses them', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ALL);
		await saveOrder(t, key);
		await publishOrder(t, key);
		const data = { orderNumber: 'A-1001', items: [] };

		const rendered = await renderOk(
			await request(t, key, 'POST', '/api/v1/render', { ...RENDER, dataVariables: data })
		);
		const sent = await request(t, key, 'POST', '/api/v1/transactional', {
			email: 'ada@example.com',
			slug: 'order',
			dataVariables: data,
		});
		const refusal = await expectRefusal('sendTransactional', sent, 400, 'invalid_variables');
		expect(rendered.missingVariables).toEqual(['firstName']);
		expect(rendered.sendRefusal).toEqual({
			status: 400,
			category: 'invalid_input',
			message: refusal.error.message,
			data: refusal.error.data,
			retryAfter: null,
		});

		const mistyped = await renderOk(
			await request(t, key, 'POST', '/api/v1/render', {
				...RENDER,
				dataVariables: { ...DATA, orderNumber: 1001 },
			})
		);
		expect(mistyped.sendRefusal.data).toEqual({
			reason: 'invalid_variables',
			field: 'dataVariables',
			variables: ['orderNumber'],
		});
	});

	it('refuses a list that writes out an oversized email with the send route’s 400', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ALL);
		const big = text('b-line', `<p>${'x'.repeat(4000)} {{item.name}}</p>`, {
			repeat: { variable: 'items', itemAlias: 'item' },
		});
		const items = Array.from({ length: 300 }, (_, i) => ({ name: `n${i}` }));
		const res = await request(t, key, 'POST', '/api/v1/render', {
			blocks: [big],
			dataVariables: { items },
		});
		const body = await expectRefusal('renderEmail', res, 400, 'invalid_variables');
		expect(body.error.data['variables']).toEqual(['items']);
	});

	it('refuses blocks a write refuses, naming the block, and lists the rest with their block', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ['templates:read']);
		const broken = { ...BLOCKS[3]!, id: 'b-broken', content: { ...BLOCKS[3]!.content, url: '' } };
		const refused = await request(t, key, 'POST', '/api/v1/render', { blocks: [broken] });
		const body = await expectRefusal('renderEmail', refused, 400, 'invalid_content');
		expect(body.error.data).toMatchObject({ field: 'blocks', blockId: 'b-broken' });
		expect(body.error.data['issues']).toContainEqual(
			expect.objectContaining({ code: 'BUTTON_NO_URL', blockId: 'b-broken', severity: 'error' })
		);

		const written = await request(t, key, 'POST', '/api/v1/render', { blocks: BLOCKS });
		const { issues } = await renderOk(written);
		expect(issues.length).toBeGreaterThan(0);
		for (const issue of issues) expect(issue.severity).not.toBe('error');
	});

	it('writes, audits, scans and schedules nothing', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ['templates:read']);
		await renderOk(
			await request(t, key, 'POST', '/api/v1/render', { ...RENDER, dataVariables: DATA })
		);
		const footprint = await t.run(async (ctx) => ({
			emails: (await ctx.db.query('transactionalEmails').collect()).length,
			templates: (await ctx.db.query('emailTemplates').collect()).length,
			audit: (await ctx.db.query('auditLogs').collect()).length,
			sends: (await ctx.db.query('transactionalSends').collect()).length,
			scheduled: (await ctx.db.system.query('_scheduled_functions').collect()).length,
		}));
		expect(footprint).toEqual({ emails: 0, templates: 0, audit: 0, sends: 0, scheduled: 0 });
	});

	it('answers a forced-dark variant on request, and the same html either way', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ['templates:read']);
		const light = await renderOk(await request(t, key, 'POST', '/api/v1/render', RENDER));
		const dark = await renderOk(
			await request(t, key, 'POST', '/api/v1/render', { ...RENDER, darkMode: true })
		);
		expect(light.darkHtml).toBeNull();
		expect(dark.html).toBe(light.html);
		expect(dark.html).toContain('@media (prefers-color-scheme:dark)');
		expect(dark.darkHtml).toContain('@media all{');
		expect(dark.darkHtml).not.toContain('prefers-color-scheme:dark');
	});

	it('renders a marketing template with contact variables, and refuses data for one', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ['templates:read']);
		const res = await renderOk(
			await request(t, key, 'POST', '/api/v1/render', { kind: 'template', blocks: BLOCKS })
		);
		expect(res.kind).toBe('template');
		expect(res.missingVariables).toEqual([]);
		expect(res.health.overall).toBeGreaterThan(0);
		const refused = await request(t, key, 'POST', '/api/v1/render', {
			kind: 'template',
			blocks: BLOCKS,
			dataVariables: DATA,
		});
		expect(refused.status).toBe(400);
		expect((await refused.json()).error.data.field).toBe('dataVariables');
	});

	it('needs templates:read; a send key is refused', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ['transactional:send']);
		const res = await request(t, key, 'POST', '/api/v1/render', RENDER);
		const body = await expectRefusal('renderEmail', res, 403, 'missing_scope');
		expect(body.error.data['scope']).toBe('templates:read');
	});

	it('has a rate limit of its own, apart from template writes and sends', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key, keyId } = await seedKey(t, ALL);
		await t.run(async (ctx) => {
			await rateLimiter.limit(ctx, 'apiRender', { key: keyId, count: 30 });
		});
		const res = await request(t, key, 'POST', '/api/v1/render', RENDER);
		await expectRefusal('renderEmail', res, 429, 'render_rate_limited');
		expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);

		const dry = await request(t, key, 'POST', '/api/v1/transactional', {
			email: 'ada@example.com',
			slug: 'order',
			dryRun: true,
		});
		await expectRefusal('sendTransactional', dry, 429, 'render_rate_limited');

		// Writes and sends spend their own buckets.
		await saveOrder(t, key);
		await publishOrder(t, key);
		const sent = await request(t, key, 'POST', '/api/v1/transactional', {
			email: 'ada@example.com',
			slug: 'order',
			dataVariables: DATA,
		});
		expect(sent.status).toBe(202);
	});
});

// ─── POST /api/v1/transactional with dryRun ─────────────────────────────────

describe('POST /api/v1/transactional with dryRun: true', () => {
	it('answers what the real send composes, with a 200 marked as a dry run', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ALL);
		const row = await saveOrder(t, key);
		await publishOrder(t, key);

		for (const language of ['en', 'de']) {
			const body = { email: 'ada@example.com', slug: 'order', language, dataVariables: DATA };
			const dry = await dryRunOk(
				await request(t, key, 'POST', '/api/v1/transactional', { ...body, dryRun: true })
			);
			const sent = await request(t, key, 'POST', '/api/v1/transactional', body);
			expect(sent.status).toBe(202);
			const message = lastSentMessage();
			expect(dry).toMatchObject({
				status: 'dry_run',
				dryRun: true,
				wouldQueue: true,
				refusal: null,
				templateId: row._id,
				slug: 'order',
				templateStatus: 'published',
				language,
				unsubscribeFooter: false,
				missingVariables: [],
			});
			expect(dry.html).toBe(message.html);
			expect(dry.text).toBe(message.text);
			expect(dry.subject).toBe(message.subject);
		}
	});

	it('queues nothing, spends no cap or Idempotency-Key and schedules nothing', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key, keyId } = await seedKey(t, ALL);
		const row = await saveOrder(t, key);
		await publishOrder(t, key);
		const before = await sendFootprint(t, row._id, keyId);
		const headers = { 'Idempotency-Key': 'order-1001' };
		const body = { email: 'ada@example.com', slug: 'order', dataVariables: DATA };

		const dry = await request(
			t,
			key,
			'POST',
			'/api/v1/transactional',
			{ ...body, dryRun: true },
			headers
		);
		expect(dry.status).toBe(200);
		expect(vi.mocked(transactionalEmailPool.enqueueAction)).not.toHaveBeenCalled();
		expect(await sendFootprint(t, row._id, keyId)).toEqual(before);

		// The key is still free: the real send with it is the first, not a replay.
		const sent = await request(t, key, 'POST', '/api/v1/transactional', body, headers);
		expect(sent.status).toBe(202);
		expect(sent.headers.get('Idempotent-Replayed')).toBeNull();
		expect((await sendFootprint(t, row._id, keyId)).sends).toBe(1);
	});

	it('reports the refusal a send would meet, word for word, and still composes', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ALL);
		await saveOrder(t, key);
		await publishOrder(t, key);
		// A first send creates the contact, so the refused dry run below has one to hide.
		const first = await request(t, key, 'POST', '/api/v1/transactional', {
			email: 'ada@example.com',
			slug: 'order',
			dataVariables: DATA,
		});
		expect(first.status).toBe(202);
		const accepted = await dryRunOk(
			await request(t, key, 'POST', '/api/v1/transactional', {
				email: 'ada@example.com',
				slug: 'order',
				dataVariables: DATA,
				dryRun: true,
			})
		);
		expect(accepted.contactId).toBe((await first.json()).data.contactId);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'ada@example.com', reason: 'bounced' })
			);
		});
		const body = { email: 'ada@example.com', slug: 'order', dataVariables: DATA };
		const sent = await request(t, key, 'POST', '/api/v1/transactional', body);
		const refusal = await expectRefusal('sendTransactional', sent, 422, 'recipient_blocked');
		const dry = await dryRunOk(
			await request(t, key, 'POST', '/api/v1/transactional', { ...body, dryRun: true })
		);
		expect(dry.wouldQueue).toBe(false);
		expect(dry.refusal).toEqual({
			status: 422,
			category: 'invalid_state',
			message: refusal.error.message,
			data: refusal.error.data,
			retryAfter: null,
		});
		expect(dry.html).toContain('Hi Ada');
		expect(dry.contactId).toBeNull();

		// A list too long to compose does not hide the send's first refusal.
		const bigLine = text('b-line', `<p>${'x'.repeat(4000)} {{item.name}}</p>`, {
			repeat: { variable: 'items', itemAlias: 'item' },
		});
		const putBig = await request(t, key, 'PUT', '/api/v1/transactional-emails/big', {
			name: 'Big',
			blocks: [bigLine],
			dataVariablesSchema: { items: 'array' },
		});
		expect(putBig.status).toBe(200);
		expect((await request(t, key, 'POST', '/api/v1/transactional-emails/big/publish')).status).toBe(
			200
		);
		const big = await request(t, key, 'POST', '/api/v1/transactional', {
			email: 'ada@example.com',
			slug: 'big',
			dataVariables: { items: Array.from({ length: 300 }, (_, i) => ({ name: `n${i}` })) },
			dryRun: true,
		});
		await expectRefusal('sendTransactional', big, 422, 'recipient_blocked');
	});

	it('reports a spent daily cap with its retry time and charges nothing', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key, keyId } = await seedKey(t, ALL);
		const row = await saveOrder(t, key);
		await publishOrder(t, key);
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, {
				transactionalSendCaps: {
					...effectiveSendCaps(undefined),
					perApiKeyDaily: { isEnabled: true, count: 1 },
					updatedAt: Date.now(),
					updatedBy: 'test-user',
				},
			});
			await rateLimiter.limit(ctx, PER_API_KEY_DAILY_BUCKET, {
				key: keyId,
				config: PER_API_KEY_DAILY_CONFIG,
			});
		});
		const before = await sendFootprint(t, row._id, keyId);
		const dry = await dryRunOk(
			await request(t, key, 'POST', '/api/v1/transactional', {
				email: 'ada@example.com',
				slug: 'order',
				dataVariables: DATA,
				dryRun: true,
			})
		);
		expect(dry.refusal).toMatchObject({ status: 429, data: { reason: 'daily_send_limit' } });
		expect(dry.refusal.retryAfter).toBeGreaterThan(0);
		expect(await sendFootprint(t, row._id, keyId)).toEqual(before);
	});

	it('composes a draft for a key that may read templates, and says it would not send', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ALL);
		await saveOrder(t, key);
		const dry = await dryRunOk(
			await request(t, key, 'POST', '/api/v1/transactional', {
				email: 'ada@example.com',
				slug: 'order',
				dataVariables: { firstName: 'Ada' },
				dryRun: true,
			})
		);
		expect(dry).toMatchObject({
			templateStatus: 'draft',
			wouldQueue: false,
			refusal: { status: 422, data: { reason: 'template_not_published' } },
			missingVariables: ['orderNumber', 'items'],
		});
		expect(dry.html).toContain('Hi Ada');
		expect(vi.mocked(transactionalEmailPool.enqueueAction)).not.toHaveBeenCalled();
	});

	it('answers a send-only key about a draft as the send does, without its content', async () => {
		const t = setupTest();
		await seedSendable(t);
		const writer = await seedKey(t, ALL);
		await saveOrder(t, writer.key);
		const { key } = await seedKey(t, ['transactional:send']);
		const res = await request(t, key, 'POST', '/api/v1/transactional', {
			email: 'ada@example.com',
			slug: 'order',
			dryRun: true,
		});
		const body = await expectRefusal('sendTransactional', res, 422, 'template_not_published');
		expect(JSON.stringify(body)).not.toContain('Hi ');
	});

	it('answers an unknown template with the send’s 404', async () => {
		const t = setupTest();
		await seedSendable(t);
		const { key } = await seedKey(t, ALL);
		const res = await request(t, key, 'POST', '/api/v1/transactional', {
			email: 'ada@example.com',
			slug: 'nope',
			dryRun: true,
		});
		await expectRefusal('sendTransactional', res, 404, 'template_not_found');
	});
});
