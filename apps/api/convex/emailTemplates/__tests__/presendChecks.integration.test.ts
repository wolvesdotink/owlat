/**
 * The pre-send checks' server round trip (`presendChecksActions.run`).
 *
 * Pinned: the floor (an anonymous caller reaches no probe), the input bounds,
 * the relay to the MTA's `/scan/content` (with the org's default sender when
 * the caller has none, and an MTA that is absent or too old read as
 * unavailable), and the per-user rate limit. The probes themselves are covered
 * in `presendProbes.test.ts`; here they are a seam.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';

const sessionMocks = vi.hoisted(() => ({
	session: null as { userId: string; role: 'owner' | 'admin' | 'editor' } | null,
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => {
			if (!sessionMocks.session) throw new Error('Not authenticated');
			return { userId: sessionMocks.session.userId, role: sessionMocks.session.role };
		}),
		requireOrgPermission: vi.fn().mockImplementation(async () => {
			const s = sessionMocks.session;
			if (!s) throw new Error('Not authenticated');
			return { userId: s.userId, role: s.role, activeOrganizationId: 'org-1' };
		}),
	};
});

const probeResources = vi.hoisted(() => vi.fn());
vi.mock('../presendProbes', () => ({ probeResources }));

const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
			path.replace(/^\.\.\//, '../../emailTemplates/'),
			module,
		])
	),
};

const fetchMock = vi.fn();

function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

function asMember(t: ReturnType<typeof setup>) {
	return t.withIdentity({
		subject: 'member-1',
		issuer: 'https://test.issuer.com',
		tokenIdentifier: 'https://test.issuer.com|member-1',
	});
}

const VERDICT = {
	enabled: true,
	verdict: 'accept',
	sizeLimitKb: 500,
	spam: { score: 2, threshold: 15 },
};

beforeEach(() => {
	sessionMocks.session = { userId: 'member-1', role: 'editor' };
	vi.stubEnv('MTA_INTERNAL_URL', 'http://mta:3100');
	vi.stubEnv('MTA_API_KEY', 'mta-master-key');
	fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify(VERDICT), { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);
	probeResources.mockReset().mockImplementation(async (links: string[], images: string[]) => ({
		links: links.map((url) => ({ url, status: 'ok', httpStatus: 200 })),
		images: images.map((url) => ({ url, status: 'ok', httpStatus: 200, bytes: 1000 })),
	}));
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('emailTemplates.presendChecksActions.run', () => {
	it('probes the deduplicated links and images and screens the message through the MTA', async () => {
		const t = asMember(setup());
		const result = await t.action(api.emailTemplates.presendChecksActions.run, {
			links: ['https://example.com/a', 'https://example.com/a', 'https://example.com/b'],
			images: ['https://cdn.example/hero.png'],
			screening: { subject: 'Hello', html: '<p>Hi</p>', fromEmail: 'news@example.com' },
		});

		expect(probeResources).toHaveBeenCalledWith(
			['https://example.com/a', 'https://example.com/b'],
			['https://cdn.example/hero.png']
		);
		expect(result.links).toHaveLength(2);
		expect(result.screening).toEqual({ status: 'ready', verdict: VERDICT });
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('http://mta:3100/scan/content');
		expect(new Headers(init.headers).get('Authorization')).toBe('Bearer mta-master-key');
		expect(JSON.parse(init.body)).toEqual({
			subject: 'Hello',
			html: '<p>Hi</p>',
			from: 'news@example.com',
		});
	});

	it("scores with the org's default sender when the caller has none", async () => {
		const t = setup();
		await t.run(async (ctx) => {
			await ctx.db.insert('campaignSenders', {
				email: 'hello@example.com',
				isEnabled: true,
				isDefault: true,
				createdBy: 'admin-1',
				createdAt: 0,
				updatedAt: 0,
			});
		});
		await asMember(t).action(api.emailTemplates.presendChecksActions.run, {
			links: [],
			images: [],
			screening: { subject: 'Hello', html: '<p>Hi</p>' },
		});

		expect(JSON.parse(fetchMock.mock.calls[0]![1].body).from).toBe('hello@example.com');
	});

	it('reads a missing or outdated MTA as unavailable, and skips screening when not asked', async () => {
		const t = asMember(setup());
		fetchMock.mockResolvedValue(new Response('Not found', { status: 404 }));
		const outdated = await t.action(api.emailTemplates.presendChecksActions.run, {
			links: [],
			images: [],
			screening: { subject: 'Hello', html: '<p>Hi</p>' },
		});
		expect(outdated.screening).toEqual({ status: 'unavailable' });

		vi.stubEnv('MTA_INTERNAL_URL', '');
		vi.stubEnv('MTA_API_URL', '');
		const none = await t.action(api.emailTemplates.presendChecksActions.run, {
			links: [],
			images: [],
			screening: { subject: 'Hello', html: '<p>Hi</p>' },
		});
		expect(none.screening).toEqual({ status: 'unavailable' });

		const notAsked = await t.action(api.emailTemplates.presendChecksActions.run, {
			links: [],
			images: [],
		});
		expect(notAsked.screening).toEqual({ status: 'not_requested' });
	});

	it('refuses anonymous callers before anything leaves the server', async () => {
		sessionMocks.session = null;
		await expect(
			setup().action(api.emailTemplates.presendChecksActions.run, {
				links: ['https://example.com/'],
				images: [],
			})
		).rejects.toThrow();
		expect(probeResources).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses input past the bounds', async () => {
		const t = asMember(setup());
		const tooMany = Array.from({ length: 201 }, (_, i) => `https://example.com/${i}`);
		await expect(
			t.action(api.emailTemplates.presendChecksActions.run, { links: tooMany, images: [] })
		).rejects.toThrow(/At most 200 links/);
		await expect(
			t.action(api.emailTemplates.presendChecksActions.run, {
				links: ['javascript:alert(1)'],
				images: [],
			})
		).rejects.toThrow(/Only http and https/);
		await expect(
			t.action(api.emailTemplates.presendChecksActions.run, {
				links: [`https://example.com/${'a'.repeat(2100)}`],
				images: [],
			})
		).rejects.toThrow(/too long/);
		expect(probeResources).not.toHaveBeenCalled();
	});

	it('rate-limits a caller who keeps re-running', async () => {
		const t = asMember(setup());
		const runs = Array.from({ length: 13 }, () =>
			t.action(api.emailTemplates.presendChecksActions.run, { links: [], images: [] }).then(
				() => 'ok',
				(error: Error) => error.message
			)
		);
		const outcomes = [];
		for (const run of runs) outcomes.push(await run);
		expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(12);
		expect(outcomes[outcomes.length - 1]).toMatch(/Too many checks/);
	});
});
