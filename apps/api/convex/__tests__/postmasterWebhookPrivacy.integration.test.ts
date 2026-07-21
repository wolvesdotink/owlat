import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { internal } from '../_generated/api';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user-1', role: 'owner' }),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-1'),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const MTA_PATH = '/webhooks/mta';
const MTA_SECRET = 'postmaster-privacy-test-secret';
const savedEnv = { ...process.env };

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function postSigned(t: ReturnType<typeof setupTest>, payload: Record<string, unknown>) {
	const body = JSON.stringify(payload);
	const timestamp = String(Math.floor(Date.now() / 1_000));
	const signature = await hmacSha256Hex(MTA_SECRET, `${timestamp}.${body}`);
	return t.fetch(MTA_PATH, {
		method: 'POST',
		body,
		headers: {
			'Content-Type': 'application/json',
			'X-MTA-Timestamp': timestamp,
			'X-MTA-Signature': signature,
		},
	});
}

async function retainedRows(t: ReturnType<typeof setupTest>) {
	return t.run(async (ctx) => ({
		payloads: await ctx.db.query('webhookPayloads').collect(),
		stats: await ctx.db.query('googlePostmasterStats').collect(),
	}));
}

beforeEach(() => {
	process.env['MTA_WEBHOOK_SECRET'] = MTA_SECRET;
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
});

afterEach(() => {
	process.env = { ...savedEnv };
});

describe('Postmaster webhook privacy boundary', () => {
	it('retains only an exact verified domain and ingests its replay idempotently', async () => {
		const t = setupTest();
		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('domains', {
				domain: 'owned.example',
				status: 'verified',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			})
		);

		const unrelatedProbe = await postSigned(t, {
			event: 'postmaster.authorize_domain',
			domain: 'unrelated-private.example',
			timestamp: now,
		});
		expect(await unrelatedProbe.json()).toMatchObject({
			disposition: 'ignored_unowned',
			retained: false,
		});

		const ownedProbe = await postSigned(t, {
			event: 'postmaster.authorize_domain',
			domain: 'owned.example',
			timestamp: now,
		});
		expect(await ownedProbe.json()).toMatchObject({
			disposition: 'accepted_authorized',
			retained: false,
		});

		const observation = {
			event: 'postmaster.stats',
			domain: 'owned.example',
			date: new Date(now - 86_400_000).toISOString().slice(0, 10),
			userReportedSpamRatio: 0.001,
			timestamp: now,
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await postSigned(t, observation);
			expect(await response.json()).toMatchObject({
				disposition: 'accepted_authorized',
				retained: true,
			});
		}

		const rows = await retainedRows(t);
		expect(rows.payloads).toHaveLength(0);
		expect(rows.stats).toHaveLength(1);
		expect(rows.stats[0]?.domain).toBe('owned.example');
	});

	it('leaves no payload or telemetry when a domain is removed before replay', async () => {
		const t = setupTest();
		const now = Date.now();
		const domainId = await t.run((ctx) =>
			ctx.db.insert('domains', {
				domain: 'removed.example',
				status: 'verified',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			})
		);
		const observation = {
			event: 'postmaster.stats',
			domain: 'removed.example',
			date: new Date(now - 86_400_000).toISOString().slice(0, 10),
			userReportedSpamRatio: 0.002,
			timestamp: now,
		};
		expect((await postSigned(t, observation)).status).toBe(200);
		await t.mutation(internal.domains.lifecycle.remove, { domainId, userId: 'user-1' });

		const replay = await postSigned(t, observation);
		expect(await replay.json()).toMatchObject({
			disposition: 'ignored_unowned',
			retained: false,
		});
		expect(await retainedRows(t)).toEqual({ payloads: [], stats: [] });

		await t.run((ctx) =>
			ctx.db.insert('domains', {
				domain: 'removed.example',
				status: 'verified',
				dnsRecords: {},
				createdAt: now + 1,
				updatedAt: now + 1,
			})
		);
		const recreated = await postSigned(t, observation);
		expect(await recreated.json()).toMatchObject({
			disposition: 'accepted_authorized',
			retained: true,
		});
		const recreatedRows = await retainedRows(t);
		expect(recreatedRows.payloads).toEqual([]);
		expect(recreatedRows.stats).toHaveLength(1);
	});

	it('keeps HMAC rejection and non-Postmaster raw audit behavior unchanged', async () => {
		const t = setupTest();
		const unsignedPrivateBody = JSON.stringify({
			event: 'postmaster.stats',
			domain: 'unsigned-private.example',
			timestamp: Date.now(),
		});
		const rejected = await t.fetch(MTA_PATH, {
			method: 'POST',
			body: unsignedPrivateBody,
			headers: { 'Content-Type': 'application/json' },
		});
		expect(rejected.status).toBe(401);
		expect(await retainedRows(t)).toEqual({ payloads: [], stats: [] });

		const normalEvent = { event: 'all_ips_blocked', timestamp: Date.now() };
		expect((await postSigned(t, normalEvent)).status).toBe(200);
		const rows = await retainedRows(t);
		expect(rows.payloads).toHaveLength(1);
		expect(JSON.parse(rows.payloads[0]!.rawPayload)).toEqual(normalEvent);
		expect(rows.stats).toHaveLength(0);
	});
});
