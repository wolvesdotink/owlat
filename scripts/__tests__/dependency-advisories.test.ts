/**
 * Dependency advisory floors for transitive packages the audit gate does not
 * block on.
 *
 * `check-security-audit.ts` fails only on high/critical findings, so a
 * low/moderate advisory can come back with any lockfile refresh and nothing
 * notices. The two packages below are pinned by root overrides instead, and
 * these tests load the exact copy each consumer resolves:
 *
 * - `ip-address` as reached from mail-sync → imapflow → socks. socks only
 *   parses and encodes literal addresses with it (no classifiers, no subnet
 *   checks), and imapflow loads socks only when a `proxy` option is set, which
 *   mail-sync never does. The fixed classifier, subnet and parse-error
 *   behaviour is pinned here together with the encoding socks relies on, so an
 *   upgrade that breaks IPv4/IPv6 proxy connects fails here first.
 * - `dompurify` as reached from apps/web → posthog-js. PostHog only sanitizes
 *   product-tour HTML strings with it (no IN_PLACE, no hooks, no
 *   SAFE_FOR_TEMPLATES). The repository has no DOM that DOMPurify runs
 *   correctly under (happy-dom's node getters defeat it), so the floor is
 *   asserted on the resolved version. The gate also blocks on two of the
 *   advisories this floor clears (GHSA-cg2g-xh64-v4q7, critical;
 *   GHSA-mrv2-3pqr-j5jr, high).
 *
 * The audit gate does block on the dev-server pair below (GHSA-587h-7wmj-h5pm,
 * high), but only in the networked Security workflow. The floors are asserted
 * on the copies the Nuxt dev server loads, so an override or lockfile change
 * that slides back to a vulnerable release also fails the script tests:
 *
 * - `vite` as reached from apps/web → nuxt → @nuxt/vite-builder. Vite bundles
 *   its own copy of launch-editor for the open-in-editor middleware, so the
 *   fix ships in vite itself (8.3.3 on the 8.3 line).
 * - `launch-editor` as reached from apps/web → nuxt → @nuxt/devtools, which
 *   opens component source files from the devtools panel.
 *
 * The gate blocks on the zod advisory too (GHSA-mrhx-c7xc-m3w5, high), but
 * acknowledges it: @nuxt/content keeps a zod 3 copy that has no fixed release
 * (see check-security-audit.ts). An acknowledgement matches the advisory for
 * every copy, so the 4.6.6 floor apps/api declares is asserted here instead:
 *
 * - every other zod copy in bun.lock is 4.6.6 or later;
 * - the copy apps/api imports rejects an oversized capped array before it
 *   parses a single element, which is the fix;
 * - @nuxt/content still requires zod 3. When it moves to zod 4 this fails, and
 *   the acknowledgement goes.
 *
 * The gate blocks on happy-dom too (GHSA-834v-8h66-3h79, high): before 21.0.4
 * its ESM compiler pasted a named import's alias into generated code unchecked,
 * so a page with JavaScript evaluation on could run host code from an invalid
 * import clause. happy-dom is only the vitest DOM of apps/web, packages/ui and
 * packages/email-builder, which never turn evaluation on, but each of them must
 * resolve the fixed release, and that copy must refuse the injected alias while
 * it still binds a valid one.
 *
 * The gate blocks on undici as well (GHSA-xjj6-f33q-929c, high): before 7.30.1
 * its `fetch()` rejected a response with more than five content codings but
 * left the body stream it had already created without an error listener, so a
 * server that then closed early crashed the process. The root override keeps
 * every consumer on one 7.x copy. The floor is asserted on the copies apps/api
 * (directly and through cheerio) and Nuxt resolve, and the copy apps/api
 * resolves must survive that response in a child process.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type * as HappyDom from 'happy-dom';
import type * as IpAddress from 'ip-address';
import type * as Socks from 'socks';
import type * as Zod from 'zod';
import { afterEach, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Each hop resolves from the previous package, the way the real consumer does.
const mailSyncRequire = createRequire(`${REPOSITORY_ROOT}apps/mail-sync/package.json`);
const imapflowRequire = createRequire(mailSyncRequire.resolve('imapflow/package.json'));
const socksRequire = createRequire(imapflowRequire.resolve('socks'));
const { SocksClient } = socksRequire('socks') as typeof Socks;
const { Address4, Address6 } = socksRequire('ip-address') as typeof IpAddress;

const webRequire = createRequire(`${REPOSITORY_ROOT}apps/web/package.json`);
const posthogRequire = createRequire(webRequire.resolve('posthog-js/package.json'));
const nuxtRequire = createRequire(webRequire.resolve('nuxt/package.json'));
const viteBuilderRequire = createRequire(nuxtRequire.resolve('@nuxt/vite-builder/package.json'));
const devtoolsRequire = createRequire(nuxtRequire.resolve('@nuxt/devtools/package.json'));

const apiRequire = createRequire(`${REPOSITORY_ROOT}apps/api/package.json`);
const { z } = apiRequire('zod') as typeof Zod;

const happyDomConsumers = ['apps/web', 'packages/ui', 'packages/email-builder'].map(
	(workspace) => [workspace, createRequire(`${REPOSITORY_ROOT}${workspace}/package.json`)] as const
);

const undiciConsumers = [
	['apps/api', apiRequire],
	['apps/api → cheerio', createRequire(apiRequire.resolve('cheerio/package.json'))],
	['apps/web → nuxt', nuxtRequire],
] as const;

const LOCKFILE = readFileSync(`${REPOSITORY_ROOT}bun.lock`, 'utf8');

function atLeast(version: string, floor: string): boolean {
	const have = version.split('.').map(Number);
	const want = floor.split('.').map(Number);
	for (let i = 0; i < want.length; i++) {
		const a = have[i] ?? 0;
		const b = want[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}

describe('ip-address on the mail-sync socks path', () => {
	it('resolves a release with the classifier, subnet and parser fixes', () => {
		const { version } = socksRequire('ip-address/package.json') as { version: string };
		expect(atLeast(version, '10.7.1'), `ip-address ${version}`).toBe(true);
	});

	it('classifies the whole fe80::/10 range as link-local', () => {
		expect(new Address6('fe80:1::1').isLinkLocal()).toBe(true);
		expect(new Address6('febf::1').isLinkLocal()).toBe(true);
		expect(new Address6('fec0::1').isLinkLocal()).toBe(false);
	});

	it('treats the NAT64 local-use prefix as private', () => {
		expect(new Address6('64:ff9b:1::1').isPrivate()).toBe(true);
	});

	it('never places an address inside a subnet of the other family', () => {
		expect(new Address4('192.0.2.1').isInSubnet(new Address6('::/0'))).toBe(false);
		expect(new Address6('::1').isInSubnet(new Address4('0.0.0.0/0'))).toBe(false);
	});

	it('keeps the parse error small for an oversized input', () => {
		const error: unknown = (() => {
			try {
				return new Address6('g'.repeat(200_000));
			} catch (caught) {
				return caught;
			}
		})();
		expect(error).toBeInstanceOf(Error);
		const { message, parseMessage } = error as Error & { parseMessage?: string };
		expect(message.length).toBeLessThan(1_000);
		expect((parseMessage ?? '').length).toBeLessThan(1_000);
	});
});

/**
 * A one-shot SOCKS5 proxy: accepts no-auth, records the CONNECT request and
 * answers with an IPv6 bound address, which socks decodes through ip-address.
 */
function fakeSocks5(boundAddress: number[]): Promise<{ server: Server; request: Promise<Buffer> }> {
	let resolveRequest: (request: Buffer) => void;
	const request = new Promise<Buffer>((resolve) => {
		resolveRequest = resolve;
	});
	const server = createServer((socket: Socket) => {
		let buffered = Buffer.alloc(0);
		let greeted = false;
		socket.on('data', (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (!greeted) {
				if (buffered.length < 2 || buffered.length < 2 + buffered[1]!) return;
				buffered = buffered.subarray(2 + buffered[1]!);
				greeted = true;
				socket.write(Buffer.from([0x05, 0x00]));
			}
			if (buffered.length < 4) return;
			const addressLength = buffered[3] === 0x01 ? 4 : buffered[3] === 0x04 ? 16 : -1;
			if (addressLength < 0 || buffered.length < 4 + addressLength + 2) return;
			resolveRequest(Buffer.from(buffered.subarray(0, 4 + addressLength + 2)));
			socket.write(Buffer.from([0x05, 0x00, 0x00, 0x04, ...boundAddress, 0x1f, 0x90]));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({ server, request }));
	});
}

describe('socks proxy connects keep their address encoding', () => {
	const BOUND = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01];
	let open: { server: Server; socket?: Socket } | null = null;

	afterEach(async () => {
		open?.socket?.destroy();
		await new Promise<void>((resolve) => (open ? open.server.close(() => resolve()) : resolve()));
		open = null;
	});

	it.each([
		['IPv4', '192.0.2.10', [0x01, 192, 0, 2, 10]],
		['IPv6', '2001:db8::10', [0x04, 0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10]],
	])(
		'encodes an %s destination and decodes the IPv6 bound address',
		async (_family, host, encoded) => {
			const { server, request } = await fakeSocks5(BOUND);
			open = { server };
			const { port } = server.address() as AddressInfo;

			const established = await SocksClient.createConnection({
				command: 'connect',
				proxy: { host: '127.0.0.1', port, type: 5 },
				destination: { host, port: 993 },
				timeout: 5_000,
			});
			open.socket = established.socket;

			expect([...(await request)]).toEqual([0x05, 0x01, 0x00, ...encoded, 0x03, 0xe1]);
			expect(established.remoteHost?.host).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
			expect(established.remoteHost?.port).toBe(8080);
		}
	);
});

describe('dompurify on the web analytics path', () => {
	it('resolves the release that neutralizes hook-detached IN_PLACE subtrees and scrubs shadow roots', () => {
		const { version } = posthogRequire('dompurify') as { version: string };
		expect(atLeast(version, '3.4.17'), `dompurify ${version}`).toBe(true);
	});
});

describe('dev-server editor launching (GHSA-587h-7wmj-h5pm)', () => {
	it('resolves a vite release with the patched launch-editor middleware', () => {
		const { version } = viteBuilderRequire('vite/package.json') as { version: string };
		expect(atLeast(version, '8.3.3'), `vite ${version}`).toBe(true);
	});

	it('resolves the launch-editor release that rejects Windows existence-check bypasses', () => {
		const { version } = devtoolsRequire('launch-editor/package.json') as { version: string };
		expect(atLeast(version, '2.14.2'), `launch-editor ${version}`).toBe(true);
	});
});

describe('zod (GHSA-mrhx-c7xc-m3w5)', () => {
	/** Every zod copy in bun.lock, keyed by install path (`zod`, `better-auth/zod`, ...). */
	function lockedZodCopies(): Map<string, string> {
		const copies = new Map<string, string>();
		for (const [, path, version] of LOCKFILE.matchAll(
			/^\s*"((?:[^"]+\/)?zod)": \["zod@([^"]+)"/gm
		)) {
			copies.set(path!, version!);
		}
		return copies;
	}

	it('locks every zod copy except the acknowledged @nuxt/content one at 4.6.6 or later', () => {
		const copies = lockedZodCopies();
		expect(copies.get('zod')).toBeDefined();
		const vulnerable = [...copies]
			.filter(([path, version]) => path !== '@nuxt/content/zod' && !atLeast(version, '4.6.6'))
			.map(([path, version]) => `${path}@${version}`);
		expect(vulnerable).toEqual([]);
	});

	it('rejects an oversized capped array before parsing any element', () => {
		let parsed = 0;
		const counted = z.string().refine(() => ++parsed > 0);
		const capped = z
			.array(counted)
			.max(2)
			.safeParse(Array.from({ length: 10_000 }, () => 'x'));
		expect(capped.error?.issues).toMatchObject([{ code: 'too_big', path: [] }]);
		expect(parsed).toBe(0);

		const invalid = z
			.array(z.number())
			.max(2)
			.safeParse(Array.from({ length: 10_000 }, () => 'x'));
		expect(invalid.error?.issues).toHaveLength(1);
	});

	it('keeps the acknowledgement only while @nuxt/content requires zod 3', () => {
		const entry = LOCKFILE.split('\n').find((line) =>
			line.trimStart().startsWith('"@nuxt/content": [')
		);
		const range = entry?.match(/"zod": "([^"]+)"/)?.[1];
		expect(range, 'drop GHSA-MRHX-C7XC-M3W5 from check-security-audit.ts').toMatch(/^\^3\./);
		expect(lockedZodCopies().get('@nuxt/content/zod')).toMatch(/^3\./);
	});
});

describe('happy-dom (GHSA-834v-8h66-3h79)', () => {
	it.each(happyDomConsumers)('resolves 21.0.4 or later from %s', (_workspace, workspaceRequire) => {
		const { version } = workspaceRequire('happy-dom/package.json') as { version: string };
		expect(atLeast(version, '21.0.4'), `happy-dom ${version}`).toBe(true);
	});

	it('binds a valid import alias but never runs code passed off as one', async () => {
		const { Window } = (await import(
			pathToFileURL(webRequire.resolve('happy-dom')).href
		)) as typeof HappyDom;
		const modules = new Map<string, [type: string, body: string]>([
			['https://advisory.test/value.js', ['text/javascript', 'export const value = 7;']],
			['https://advisory.test/empty.json', ['application/json', '{}']],
		]);
		const window = new Window({
			url: 'https://advisory.test/',
			settings: {
				// The advisory needs evaluation on. Owlat's test environments leave it off.
				enableJavaScriptEvaluation: true,
				suppressCodeGenerationFromStringsWarning: true,
				fetch: {
					interceptor: {
						async beforeAsyncRequest({ request, window }) {
							const [type, body] = modules.get(request.url) ?? ['text/plain', ''];
							return new window.Response(body, {
								status: body ? 200 : 404,
								headers: { 'content-type': type },
							});
						},
					},
				},
			},
		});
		try {
			for (const source of [
				"import { value as aliased } from './value.js'; globalThis.boundAlias = aliased;",
				"import { missing as injected = globalThis.injected = 1337 } from './empty.json' with { type: 'json' };",
			]) {
				const script = window.document.createElement('script');
				script.type = 'module';
				script.textContent = source;
				window.document.body.appendChild(script);
			}
			await window.happyDOM.waitUntilComplete();
			const globals = window as unknown as { boundAlias?: unknown; injected?: unknown };
			expect(globals.boundAlias).toBe(7);
			expect(globals.injected).toBeUndefined();
		} finally {
			await window.happyDOM.close();
		}
	});
});

describe('undici (GHSA-xjj6-f33q-929c)', () => {
	/** First fixed release on each line the advisory covers. */
	const FIXED = new Map([
		['6', '6.29.1'],
		['7', '7.30.1'],
		['8', '8.12.2'],
	]);

	it.each(undiciConsumers)('resolves a fixed release from %s', (_consumer, consumerRequire) => {
		const { version } = consumerRequire('undici/package.json') as { version: string };
		const floor = FIXED.get(version.split('.')[0]!);
		expect(floor, `undici ${version} is on a line the floor does not cover`).toBeDefined();
		expect(atLeast(version, floor!), `undici ${version}`).toBe(true);
	});

	it('survives a response with too many content codings and an early close', async () => {
		// The unfixed release crashes the whole process on an unhandled stream
		// error, so the fetch runs in a child process and the test reads its exit.
		const probe = `
			import { createServer } from 'node:net';
			const undici = await import(process.env.UNDICI_ENTRY);
			const server = createServer((socket) => socket.once('data', () => socket.end(
				'HTTP/1.1 200 OK\\r\\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\\r\\n' +
				'Content-Length: 100\\r\\n\\r\\n'
			)));
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			const dispatcher = new undici.Agent();
			const outcome = await undici
				.fetch('http://127.0.0.1:' + server.address().port + '/', { dispatcher })
				.then(() => 'resolved', (error) => String(error.cause?.message ?? error));
			// close() waits for the socket to end, which is where the orphaned
			// stream used to fail.
			await dispatcher.close();
			server.close();
			console.log(outcome);
		`;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			['--input-type=module', '--eval', probe],
			{ env: { ...process.env, UNDICI_ENTRY: pathToFileURL(apiRequire.resolve('undici')).href } }
		);
		expect(stdout.trim()).toBe('too many content-encodings in response: 6, maximum allowed is 5');
	});
});
