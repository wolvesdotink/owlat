// @vitest-environment node
/**
 * The workflow resets the test deployment when a run ends, so the seeded
 * owner's sessions stop authenticating (#1222). A transient failure is retried
 * within a bound, a definitive one is not. The call goes through Node's
 * `fetch`, and neither its errors nor its retry lines name the secret or the
 * deployment.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resetDeployment } from '../resetDeployment';

const SECRET = 'dummy-instance-secret-4f1c';
const SITE = 'https://dummy-site-7c1e.example.invalid';
const CLI = resolve(__dirname, '../reset-deployment.ts');

function respond(status: number, body: string) {
	return vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
}

const OK = JSON.stringify({ deleted: { sessions: 1, users: 1 } });

function networkError(code = 'ECONNRESET') {
	const cause = Object.assign(new Error(`read ${code} dummy-site-7c1e.example.invalid`), { code });
	return new TypeError('fetch failed', { cause });
}

/** A reply whose body breaks off after the headers. */
function brokenBody(status = 200) {
	const body = new ReadableStream({
		start(controller) {
			controller.error(networkError());
		},
	});
	return new Response(body, { status });
}

/** A virtual clock: `sleep` advances it instead of waiting. */
function clock() {
	let time = 0;
	const waits: number[] = [];
	return {
		waits,
		now: () => time,
		sleep: async (ms: number) => {
			waits.push(ms);
			time += ms;
		},
	};
}

/** `resetDeployment` on a virtual clock, collecting its retry lines. */
function reset(fetchImpl: typeof fetch, extra: { attempts?: number; deadlineMs?: number } = {}) {
	const time = clock();
	const lines: string[] = [];
	const result = resetDeployment({
		siteUrl: SITE,
		instanceSecret: SECRET,
		fetchImpl,
		now: time.now,
		sleep: time.sleep,
		log: (line) => lines.push(line),
		...extra,
	});
	return { result, lines, waits: time.waits };
}

describe('resetDeployment', () => {
	it('posts to /dev/reset with the secret header and returns what was deleted', async () => {
		const fetchImpl = respond(200, JSON.stringify({ deleted: { sessions: 2, users: 1 } }));

		const result = await resetDeployment({ siteUrl: SITE, instanceSecret: SECRET, fetchImpl });

		expect(result).toEqual({ deleted: { sessions: 2, users: 1 } });
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe(`${SITE}/dev/reset`);
		expect(init?.method).toBe('POST');
		expect(init?.headers).toEqual({ 'X-Instance-Secret': SECRET });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([
		[401, '{"error":"unauthorized"}'],
		[403, '{"error":"forbidden"}'],
		[404, 'not found'],
	])(
		'fails on HTTP %i at once, naming the status and body but not the secret',
		async (status, body) => {
			const fetchImpl = respond(status, body);

			const { result, lines } = reset(fetchImpl);
			await expect(result).rejects.toThrow(`HTTP ${status}: ${body}`);
			await expect(result).rejects.not.toThrow(SECRET);
			expect(fetchImpl).toHaveBeenCalledOnce();
			expect(lines).toEqual([]);
		}
	);

	it.each([
		['a body that is not JSON', 'ok'],
		['no deleted counts', '{"ok":true}'],
	])('fails on a 200 with %s, which is not a reset that ran', async (_what, body) => {
		const fetchImpl = respond(200, body);

		await expect(
			resetDeployment({ siteUrl: SITE, instanceSecret: SECRET, fetchImpl })
		).rejects.toThrow('POST /dev/reset answered 200');
	});

	it('fails on a network error without naming the deployment', async () => {
		// One attempt, so the error is the network error itself.
		const cause = Object.assign(
			new Error('getaddrinfo ENOTFOUND dummy-site-7c1e.example.invalid'),
			{
				code: 'ENOTFOUND',
			}
		);
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new TypeError('fetch failed', { cause }));

		const failure = reset(fetchImpl, { attempts: 1 }).result;
		await expect(failure).rejects.toThrow('did not reach the deployment (ENOTFOUND)');
		await expect(failure).rejects.not.toThrow('example.invalid');
	});
});

describe('resetDeployment, retries', () => {
	it('retries a transient network error and succeeds', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(networkError())
			.mockResolvedValue(new Response(OK));

		const { result, lines, waits } = reset(fetchImpl);
		await expect(result).resolves.toEqual({ deleted: { sessions: 1, users: 1 } });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(waits).toEqual([2_000]);
		expect(lines).toEqual([
			'POST /dev/reset attempt 1 of 5 failed: POST /dev/reset did not reach the deployment ' +
				'(ECONNRESET). Retrying in 2 s.',
		]);
	});

	it.each([408, 425, 429, 500, 502, 503, 504])('retries HTTP %i and succeeds', async (status) => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response('{"error":"unavailable"}', { status }))
			.mockResolvedValue(new Response(OK));

		const { result } = reset(fetchImpl);
		await expect(result).resolves.toEqual({ deleted: { sessions: 1, users: 1 } });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('waits as long as a 429 asks, when that is longer than the backoff', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }))
			.mockResolvedValue(new Response(OK));

		const { result, waits } = reset(fetchImpl);
		await expect(result).resolves.toBeDefined();
		expect(waits).toEqual([7_000]);
	});

	it('retries a reply whose body breaks off', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(brokenBody())
			.mockResolvedValue(new Response(OK));

		const { result, lines } = reset(fetchImpl);
		await expect(result).resolves.toEqual({ deleted: { sessions: 1, users: 1 } });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(lines[0]).toContain('returned HTTP 200, but reading its body failed');
	});

	it('fails once the attempts are used up, backing off between them', async () => {
		const fetchImpl = respond(503, '{"error":"unavailable"}');
		fetchImpl.mockImplementation(
			async () => new Response('{"error":"unavailable"}', { status: 503 })
		);

		const { result, lines, waits } = reset(fetchImpl);
		await expect(result).rejects.toThrow(
			'POST /dev/reset returned HTTP 503: {"error":"unavailable"} Gave up after 5 attempts.'
		);
		expect(fetchImpl).toHaveBeenCalledTimes(5);
		expect(waits).toEqual([2_000, 4_000, 8_000, 16_000]);
		expect(lines).toHaveLength(4);
	});

	it('starts no attempt past the overall deadline', async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(networkError());

		const { result, waits } = reset(fetchImpl, { deadlineMs: 10_000 });
		await expect(result).rejects.toThrow(
			'Gave up after 3 attempts: the 10 s deadline leaves no time for another.'
		);
		// 2 s + 4 s leave 4 s, too little for the next 8 s wait.
		expect(waits).toEqual([2_000, 4_000]);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it('gives each attempt only the time the deadline has left', async () => {
		const time = clock();
		const signals: AbortSignal[] = [];
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			signals.push(init!.signal!);
			if (signals.length === 1) throw networkError();
			return new Response(OK);
		});
		const timeout = vi.spyOn(AbortSignal, 'timeout');

		await resetDeployment({
			siteUrl: SITE,
			instanceSecret: SECRET,
			fetchImpl,
			now: time.now,
			sleep: time.sleep,
			timeoutMs: 120_000,
			deadlineMs: 50_000,
		});
		expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([50_000, 48_000]);
		timeout.mockRestore();
	});

	it('never names the secret or the deployment in a retry line or the final error', async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(networkError('ENOTFOUND'));

		const { result, lines } = reset(fetchImpl);
		const error = (await result.catch((caught: unknown) => caught)) as Error;
		for (const text of [...lines, error.message, String(error.stack)]) {
			expect(text).not.toContain(SECRET);
			expect(text).not.toContain('example.invalid');
		}
		expect(error.cause).toBeUndefined();
	});
});

describe('reset-deployment CLI', () => {
	it.each([[{ CONVEX_TEST_SITE_URL: SITE }], [{ CONVEX_TEST_INSTANCE_SECRET: SECRET }]])(
		'fails before any request when a variable is missing',
		(env) => {
			const result = spawnSync('bun', [CLI], {
				env: {
					PATH: process.env['PATH'],
					CONVEX_TEST_SITE_URL: '',
					CONVEX_TEST_INSTANCE_SECRET: '',
					...env,
				},
				encoding: 'utf8',
			});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('must both be set');
		}
	);

	/** Run the CLI against a loopback server that answers with `replies`, in order. */
	async function runAgainst(replies: Array<{ status: number; body: string }>) {
		const requests: string[] = [];
		const server = createServer((request, response) => {
			requests.push(String(request.headers['x-instance-secret']));
			const reply = replies[Math.min(requests.length, replies.length) - 1]!;
			response.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body);
		});
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		const { port } = server.address() as AddressInfo;
		try {
			const child = spawn('bun', [CLI], {
				env: {
					PATH: process.env['PATH'],
					CONVEX_TEST_SITE_URL: `http://127.0.0.1:${port}`,
					CONVEX_TEST_INSTANCE_SECRET: SECRET,
				},
			});
			let output = '';
			child.stdout.on('data', (chunk) => (output += chunk));
			child.stderr.on('data', (chunk) => (output += chunk));
			const status = await new Promise<number | null>((done) => child.on('close', done));
			return { status, output, requests, port };
		} finally {
			server.close();
		}
	}

	it('retries a 503 with a warning, then reports what was deleted', async () => {
		const run = await runAgainst([
			{ status: 503, body: '{"error":"unavailable"}' },
			{ status: 200, body: OK },
		]);
		expect(run.status).toBe(0);
		expect(run.requests).toEqual([SECRET, SECRET]);
		expect(run.output).toContain('::warning::POST /dev/reset attempt 1 of 5 failed');
		expect(run.output).toContain('Test deployment reset; deleted: {"sessions":1,"users":1}');
		expect(run.output).not.toContain(SECRET);
		expect(run.output).not.toContain(String(run.port));
	});

	it('fails at once on a 401, naming no host and no secret', async () => {
		const run = await runAgainst([{ status: 401, body: '{"error":"unauthorized"}' }]);
		expect(run.status).toBe(1);
		expect(run.requests).toHaveLength(1);
		expect(run.output).toContain('::error::POST /dev/reset returned HTTP 401');
		expect(run.output).not.toContain(SECRET);
		expect(run.output).not.toContain('127.0.0.1');
	});
});
