import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import {
	fetchStsPolicyText,
	stsPolicyHost,
	STS_FETCH_TIMEOUT,
	STS_MAX_POLICY_BYTES,
	type StsResolver,
} from '../mtaStsFetch.js';
import {
	startPolicyServer,
	STS_TEST_DOMAIN,
	type PolicyServer,
} from './helpers/stsPolicyServer.js';

const POLICY = 'version: STSv1\nmode: enforce\nmx: mx1.owlat.test\nmax_age: 604800\n';

// Issue #1326: the policy host is attacker-controlled. RFC 8461 §3.3 pins the
// request to one HTTPS URL; these tests run the real request code against a
// loopback HTTPS server with certificate checks on.
describe('fetchStsPolicyText', () => {
	const cleanups: Array<() => Promise<void>> = [];

	async function policyServer(
		handler: Parameters<typeof startPolicyServer>[0]
	): Promise<PolicyServer> {
		const server = await startPolicyServer(handler);
		cleanups.push(server.close);
		return server;
	}

	/** A plain-HTTP server standing in for an internal service; counts requests. */
	async function internalServer(): Promise<{ url: string; requests: () => number }> {
		let requests = 0;
		const server: Server = createServer((_req, res) => {
			requests++;
			res.end(POLICY);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		cleanups.push(() => {
			server.closeAllConnections();
			return new Promise((resolve) => server.close(() => resolve()));
		});
		return {
			url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
			requests: () => requests,
		};
	}

	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((close) => close()));
	});

	it('GETs /.well-known/mta-sts.txt on mta-sts.<domain> over verified TLS', async () => {
		let seen: { host?: string; url?: string; encoding?: string } = {};
		const server = await policyServer((req, res) => {
			seen = { host: req.headers.host, url: req.url, encoding: req.headers['accept-encoding'] };
			res.end(POLICY);
		});

		await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).resolves.toBe(POLICY);
		expect(seen.host).toBe(`mta-sts.${STS_TEST_DOMAIN}:${server.transport.port}`);
		expect(seen.url).toBe('/.well-known/mta-sts.txt');
		expect(seen.encoding).toBe('identity');
	});

	it('still reads a valid policy served in small chunks', async () => {
		const server = await policyServer((_req, res) => {
			for (const line of POLICY.split('\n')) res.write(`${line}\n`);
			res.end();
		});

		const text = await fetchStsPolicyText(STS_TEST_DOMAIN, server.transport);
		expect(text.split('\n').filter(Boolean)).toEqual(POLICY.split('\n').filter(Boolean));
	});

	it('refuses a trusted certificate that names the host only in its CN', async () => {
		// Node falls back to the CN when a cert has no DNS subjectAltName; the
		// policy fetch must not (RFC 8461 §3.3 via RFC 6125).
		const server = await startPolicyServer((_req, res) => res.end(POLICY), { cnOnly: true });
		cleanups.push(server.close);

		await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
			/no DNS subjectAltName/
		);
	});

	it('fails on a certificate the trust store does not accept', async () => {
		const server = await policyServer((_req, res) => res.end(POLICY));
		const { ca: _ca, ...untrusted } = server.transport;

		await expect(fetchStsPolicyText(STS_TEST_DOMAIN, untrusted)).rejects.toThrow();
	});

	describe('destination', () => {
		it.each([
			['127.0.0.1'],
			['10.1.2.3'],
			['169.254.169.254'],
			['::1'],
			['fd00::1'],
			['::ffff:127.0.0.1'],
			['64:ff9b:1::a9fe:a9fe'],
			['64:ff9b:1::808:808'],
		])('refuses a policy host resolving to %s without connecting', async (address) => {
			const server = await policyServer((_req, res) => res.end(POLICY));
			const resolve: StsResolver = (_host, _opts, callback) =>
				callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]);
			// Only the resolver is swapped: the default public-address policy decides.
			const { isAllowedAddress: _allow, ...transport } = server.transport;

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, { ...transport, resolve })).rejects.toThrow(
				/non-public address/
			);
			expect(server.requests()).toBe(0);
		});

		it('refuses when any one of several addresses is non-public', async () => {
			const server = await policyServer((_req, res) => res.end(POLICY));
			const resolve: StsResolver = (_host, _opts, callback) =>
				callback(null, [
					{ address: '203.0.113.7', family: 4 },
					{ address: '192.168.0.10', family: 4 },
				]);
			const { isAllowedAddress: _allow, ...transport } = server.transport;

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, { ...transport, resolve })).rejects.toThrow(
				/192\.168\.0\.10/
			);
			expect(server.requests()).toBe(0);
		});

		it('lets a public address through the default policy to the connect step', async () => {
			// 192.0.2.0/24 (TEST-NET-1) is public to the classifier but unroutable, so
			// the request fails at connect or the time budget, never at the guard.
			const resolve: StsResolver = (_host, _opts, callback) =>
				callback(null, [{ address: '192.0.2.1', family: 4 }]);

			const err = await fetchStsPolicyText(STS_TEST_DOMAIN, { resolve, timeoutMs: 300 }).catch(
				(e: Error) => e
			);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).not.toMatch(/non-public|no address/);
		});

		it.each([
			['', 'empty'],
			['localhost', 'single label'],
			['127.0.0.1', 'IPv4 literal'],
			['[::1]', 'IPv6 literal'],
			['evil.test:8080', 'port'],
			['evil.test/x', 'path'],
			['user@evil.test', 'userinfo'],
			['evil..test', 'empty label'],
			['-evil.test', 'leading hyphen'],
			[`${'a'.repeat(64)}.test`, 'label over 63'],
			[`${'a.'.repeat(124)}test`, 'name over 253'],
		])('rejects malformed recipient domain %j (%s) without a request', async (domain) => {
			const server = await policyServer((_req, res) => res.end(POLICY));

			expect(stsPolicyHost(domain)).toBeNull();
			await expect(fetchStsPolicyText(domain, server.transport)).rejects.toThrow(
				/not a valid recipient domain/
			);
			expect(server.requests()).toBe(0);
		});

		it('normalizes case, a trailing dot and Unicode labels', () => {
			expect(stsPolicyHost('Example.COM.')).toBe('mta-sts.example.com');
			expect(stsPolicyHost('bücher.example')).toBe('mta-sts.xn--bcher-kva.example');
		});
	});

	describe('redirects (RFC 8461 §3.3: MUST NOT be followed)', () => {
		it.each([301, 302, 303, 307, 308])(
			'refuses a %i to a private plaintext target, which gets no request',
			async (status) => {
				const internal = await internalServer();
				const server = await policyServer((_req, res) => {
					res.writeHead(status, { Location: internal.url });
					res.end();
				});

				await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
					/refused redirect/
				);
				expect(internal.requests()).toBe(0);
			}
		);
	});

	describe('response size', () => {
		it('rejects a declared Content-Length over the cap without reading the body', async () => {
			const server = await policyServer((_req, res) => {
				res.writeHead(200, { 'Content-Length': String(1024 * 1024) });
				res.write('version: STSv1\n');
				// Never finish: a read that waited for the body would hit the timeout.
			});

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
				/too large/
			);
		});

		it('rejects a chunked body with no length at the cap', async () => {
			let written = 0;
			let closed = false;
			const server = await policyServer((_req, res) => {
				res.on('close', () => (closed = true));
				const chunk = `mx: ${'a'.repeat(1019)}\n`;
				const pump = () => {
					// Keep writing until the client hangs up; stop at 4 MiB either way.
					while (!res.destroyed && written < 4 * 1024 * 1024) {
						written += chunk.length;
						if (!res.write(chunk)) return void res.once('drain', pump);
					}
					res.end();
				};
				pump();
			});

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
				/exceeds/
			);
			// The client dropped the connection instead of draining the whole body.
			await expect.poll(() => closed).toBe(true);
			expect(written).toBeLessThan(4 * 1024 * 1024);
		});

		it('accepts a body of exactly the cap', async () => {
			const body = 'x'.repeat(STS_MAX_POLICY_BYTES);
			const server = await policyServer((_req, res) => res.end(body));

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).resolves.toHaveLength(
				STS_MAX_POLICY_BYTES
			);
		});

		it('counts decoded bytes: a small gzip body that inflates past the cap is rejected', async () => {
			const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 'a'));
			expect(bomb.byteLength).toBeLessThan(STS_MAX_POLICY_BYTES);
			const server = await policyServer((_req, res) => {
				res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': bomb.byteLength });
				res.end(bomb);
			});

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
				/exceeds/
			);
		});

		it('decodes a gzip policy the server compressed anyway', async () => {
			const server = await policyServer((_req, res) => {
				res.writeHead(200, { 'Content-Encoding': 'gzip' });
				res.end(gzipSync(POLICY));
			});

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).resolves.toBe(POLICY);
		});

		it('rejects an unsupported content-encoding', async () => {
			const server = await policyServer((_req, res) => {
				res.writeHead(200, { 'Content-Encoding': 'zstd' });
				res.end(POLICY);
			});

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
				/unsupported content-encoding/
			);
		});

		it('counts multibyte text by its bytes, not its characters', async () => {
			// 3 bytes per character: under the cap in characters, over it in bytes.
			const body = '€'.repeat(Math.ceil(STS_MAX_POLICY_BYTES / 3) + 1);
			const server = await policyServer((_req, res) => res.end(body));

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
				/too large|exceeds/
			);
		});
	});

	// RFC 8461 §3.3: the policy is served with media type text/plain.
	describe('media type', () => {
		it.each(['text/plain; charset=utf-8', 'TEXT/PLAIN', 'text/plain;charset="us-ascii"'])(
			'accepts %j',
			async (contentType) => {
				const server = await policyServer((_req, res) => {
					res.setHeader('Content-Type', contentType);
					res.end(POLICY);
				});

				await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).resolves.toBe(POLICY);
			}
		);

		it.each([
			'text/html',
			'application/octet-stream',
			'text/plainx',
			'text/plain-ish; charset=utf-8',
		])('rejects %j', async (contentType) => {
			const server = await policyServer((_req, res) => {
				res.setHeader('Content-Type', contentType);
				res.end(POLICY);
			});

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
				/not text\/plain/
			);
		});

		it('rejects a response with no Content-Type', async () => {
			const server = await policyServer((_req, res) => {
				res.removeHeader('Content-Type');
				res.end(POLICY);
			});

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
				/missing, not text\/plain/
			);
		});
	});

	describe('status and timeout', () => {
		it.each([204, 206])('throws on a %i: only a 200 is a policy', async (status) => {
			const server = await policyServer((_req, res) => {
				res.writeHead(status, status === 206 ? { 'Content-Range': 'bytes 0-9/100' } : {});
				res.end(status === 206 ? POLICY.slice(0, 10) : undefined);
			});

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
				new RegExp(`failed: ${status}`)
			);
		});

		it.each([404, 503])('throws on a %i', async (status) => {
			const server = await policyServer((_req, res) => {
				res.writeHead(status);
				res.end('nope');
			});

			await expect(fetchStsPolicyText(STS_TEST_DOMAIN, server.transport)).rejects.toThrow(
				new RegExp(String(status))
			);
		});

		it('defaults to a 10s budget', () => {
			expect(STS_FETCH_TIMEOUT).toBe(10_000);
		});

		it('aborts a slow-drip body at the time budget', async () => {
			let timer: ReturnType<typeof setInterval> | undefined;
			const server = await policyServer((_req, res) => {
				res.writeHead(200);
				res.write('version: STSv1\n');
				// One byte every 20ms: never over the size cap, never finished.
				timer = setInterval(() => res.write('x'), 20);
				res.on('close', () => clearInterval(timer));
			});
			cleanups.push(async () => clearInterval(timer));

			const started = Date.now();
			await expect(
				fetchStsPolicyText(STS_TEST_DOMAIN, { ...server.transport, timeoutMs: 300 })
			).rejects.toThrow(/timed out/);
			expect(Date.now() - started).toBeLessThan(5_000);
		});

		it('aborts a server that never sends headers at the time budget', async () => {
			const server = await policyServer(() => {
				// Accept the request and say nothing.
			});

			await expect(
				fetchStsPolicyText(STS_TEST_DOMAIN, { ...server.transport, timeoutMs: 300 })
			).rejects.toThrow();
		});
	});
});
