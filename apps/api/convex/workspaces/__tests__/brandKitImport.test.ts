/**
 * Brand kit "Import from website" (`workspaces/brandKitImport.ts`): only
 * owners and admins, every fetch through the SSRF guard, every failure an
 * outcome rather than a throw, and a logo saved only when its bytes pass.
 *
 * `fetchGuarded` is mocked so the outcomes do not depend on the network; the
 * guard itself (redirect hops included) is covered by lib/__tests__/ssrfGuard.
 */
import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { SsrfBlockedError } from '../../lib/ssrfGuard';

const auth = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'editor' }));
const net = vi.hoisted(() => ({ fetchGuarded: vi.fn() }));

vi.mock('../../lib/sessionOrganization', async () => {
	const member = async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
		if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
		return { userId: 'user-A', role: auth.role, activeOrganizationId: 'org-1' };
	};
	return {
		...(await vi.importActual('../../lib/sessionOrganization')),
		requireOrgMember: vi.fn(member),
		getMutationContext: vi.fn(member),
		requireOrgPermission: vi.fn(async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
			const session = await member(ctx);
			if (auth.role === 'editor') throw new Error('forbidden');
			return session;
		}),
	};
});

vi.mock('../../lib/ssrfGuard', async () => ({
	...(await vi.importActual('../../lib/ssrfGuard')),
	fetchGuarded: net.fetchGuarded,
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

const identity = {
	subject: 'user-A',
	issuer: 'https://test.issuer.example',
	tokenIdentifier: 'https://test.issuer.example|user-A',
};

function client() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t.withIdentity(identity);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function respond(body: BodyInit | null, type: string, status = 200): Response {
	return new Response(body, { status, headers: { 'content-type': type } });
}

/** A body that sends `first`, then fails, as a dropped connection or a fired timeout does. */
function failingBody(first: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(first));
			controller.error(new Error('connection reset'));
		},
	});
}

const PAGE = `<!doctype html><html><head>
<meta name="theme-color" content="#0f766e">
<title>Northwind</title>
<link rel="stylesheet" href="/broken.css">
<link rel="stylesheet" href="/site.css">
<link rel="apple-touch-icon" href="/touch.png">
</head><body></body></html>`;

beforeEach(() => {
	auth.role = 'owner';
	net.fetchGuarded.mockReset();
});

describe('importFromWebsite', () => {
	it('is refused to an editor before anything is fetched', async () => {
		auth.role = 'editor';
		await expect(
			client().action(api.workspaces.brandKitImport.importFromWebsite, { url: 'example.com' })
		).rejects.toThrow(/forbidden/);
		expect(net.fetchGuarded).not.toHaveBeenCalled();
	});

	it('proposes a kit, and a stylesheet that fails mid-read is skipped', async () => {
		net.fetchGuarded.mockImplementation(async (url: string) => {
			if (url.endsWith('/broken.css')) return respond(failingBody('a{color:'), 'text/css');
			if (url.endsWith('/site.css')) {
				return respond('a{color:#1f2937} b{color:#1f2937} body{background:#ffffff}', 'text/css');
			}
			return respond(PAGE, 'text/html; charset=utf-8');
		});
		const result = await client().action(api.workspaces.brandKitImport.importFromWebsite, {
			url: 'example.com:8443',
		});
		expect(result).toMatchObject({
			ok: true,
			value: {
				primaryColor: '#0f766e',
				textColor: '#1f2937',
				companyName: 'Northwind',
				logoCandidates: [{ url: 'https://example.com:8443/touch.png', source: 'appleTouchIcon' }],
			},
		});
		// Every request went through the guard, following a bounded number of redirects.
		const [pageUrl, init] = net.fetchGuarded.mock.calls[0]!;
		expect(pageUrl).toBe('https://example.com:8443/');
		expect(init.maxRedirects).toBe(4);
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(net.fetchGuarded).toHaveBeenCalledTimes(3);
	});

	it('reports a page whose body fails mid-read as unreachable', async () => {
		net.fetchGuarded.mockResolvedValue(respond(failingBody('<html><head>'), 'text/html'));
		const result = await client().action(api.workspaces.brandKitImport.importFromWebsite, {
			url: 'https://example.com',
		});
		expect(result).toEqual({ ok: false, error: 'unreachable' });
	});

	it('maps refusals and odd answers to outcomes', async () => {
		const t = client();
		const run = (url: string) => t.action(api.workspaces.brandKitImport.importFromWebsite, { url });

		expect(await run('javascript:alert(1)')).toEqual({ ok: false, error: 'invalid_url' });
		expect(await run('   ')).toEqual({ ok: false, error: 'invalid_url' });

		net.fetchGuarded.mockRejectedValueOnce(new SsrfBlockedError('private address'));
		expect(await run('intranet.example')).toEqual({ ok: false, error: 'blocked' });

		net.fetchGuarded.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		expect(await run('example.com')).toEqual({ ok: false, error: 'unreachable' });

		net.fetchGuarded.mockResolvedValueOnce(respond('gone', 'text/html', 404));
		expect(await run('example.com')).toEqual({ ok: false, error: 'unreachable' });

		net.fetchGuarded.mockResolvedValueOnce(respond('{}', 'application/json'));
		expect(await run('example.com')).toEqual({ ok: false, error: 'not_html' });
	});

	it('is rate limited per user', async () => {
		const t = client();
		const outcomes = [];
		for (let i = 0; i < 16; i++) {
			outcomes.push(
				await t.action(api.workspaces.brandKitImport.importFromWebsite, { url: 'javascript:x' })
			);
		}
		expect(outcomes.at(-1)).toEqual({ ok: false, error: 'rate_limited' });
		expect(net.fetchGuarded).not.toHaveBeenCalled();
	});
});

describe('importLogo', () => {
	it('adds an accepted PNG to the media library', async () => {
		net.fetchGuarded.mockResolvedValue(respond(PNG, 'image/png'));
		const t = client();
		const result = await t.action(api.workspaces.brandKitImport.importLogo, {
			url: 'https://www.example.com/touch.png',
		});
		if (!result.ok) throw new Error(`import failed: ${result.error}`);
		const asset = await t.run((ctx) => ctx.db.get(result.value.mediaAssetId));
		expect(asset).toMatchObject({
			filename: 'example.com-logo.png',
			mimeType: 'image/png',
			fileSize: PNG.byteLength,
			tags: ['brand-kit'],
			uploadedBy: 'user-A',
		});
	});

	it('takes only real logo images, within the size cap, and stores nothing otherwise', async () => {
		const t = client();
		const run = () =>
			t.action(api.workspaces.brandKitImport.importLogo, { url: 'https://example.com/logo' });

		net.fetchGuarded.mockResolvedValueOnce(respond('<html>', 'text/html'));
		expect(await run()).toEqual({ ok: false, error: 'not_image' });

		// The type says PNG; the bytes do not.
		net.fetchGuarded.mockResolvedValueOnce(respond('not a png', 'image/png'));
		expect(await run()).toEqual({ ok: false, error: 'not_image' });

		net.fetchGuarded.mockResolvedValueOnce(
			respond(new Uint8Array(2 * 1024 * 1024 + 1), 'image/png')
		);
		expect(await run()).toEqual({ ok: false, error: 'too_large' });

		net.fetchGuarded.mockResolvedValueOnce(respond(failingBody('\x89PNG'), 'image/png'));
		expect(await run()).toEqual({ ok: false, error: 'unreachable' });

		expect(await t.run((ctx) => ctx.db.query('mediaAssets').collect())).toEqual([]);
	});
});
