// @vitest-environment node
/**
 * The credentials a run mints, and the deployment URLs, must never reach the
 * public E2E report (#1222). The scan before upload refuses JWT-shaped values
 * and trace archives, and searches for the URLs' hosts and the session cookies
 * the setup project saved in its storage state.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JWT_LABEL, TRACE_LABEL, findSecretsInReport, scanReport } from '../scanReportSecrets';
import { storageStateSecrets, withUrlHosts } from '../sessionSecrets';
import { makeZip } from './zipFixtures';

const CLI = resolve(__dirname, '../scan-report-secrets.ts');

/** A JWT of the shape the Convex token endpoint returns, built from dummy claims. */
const JWT = [
	{ alg: 'RS256', typ: 'JWT', kid: 'dummy-key' },
	{ sub: 'dummy-user', iss: 'https://site.example.invalid', exp: 1 },
	'dummy-signature-bytes',
]
	.map((part) => Buffer.from(typeof part === 'string' ? part : JSON.stringify(part)))
	.map((bytes) => bytes.toString('base64url'))
	.join('.');

const CONVEX_URL = 'https://dummy-deployment-7c1e.example.invalid';
const SESSION_TOKEN = 'dummysessiontoken0123456789abcdef';
const SIGNED_COOKIE = `${SESSION_TOKEN}.c2lnbmF0dXJl+x=`;
const STORAGE_STATE = JSON.stringify({
	cookies: [
		{ name: 'better-auth.session_token', value: encodeURIComponent(SIGNED_COOKIE) },
		{ name: 'locale', value: 'de' },
	],
	origins: [
		{
			origin: 'http://localhost:3000',
			localStorage: [
				{ name: 'owlat:welcomed:dummy-user', value: '1' },
				{ name: 'dummy-cache', value: 'dummy-long-local-storage-value' },
			],
		},
	],
});

/** The trace layout Playwright 1.59 writes: action log, network log, stacks, resources. */
function traceZip(network = '{}\n'): Buffer {
	return makeZip({
		'test.trace': '{"type":"context-options"}\n',
		'0-trace.trace': '{"type":"before"}\n',
		'0-trace.network': network,
		'0-trace.stacks': '{}',
		'resources/abc.dat': 'body',
	});
}

let report: string;

beforeEach(() => {
	report = mkdtempSync(join(tmpdir(), 'owlat-report-'));
	mkdirSync(join(report, 'data'));
});

afterEach(() => {
	rmSync(report, { recursive: true, force: true });
});

describe('scanReport, JWT-shaped values', () => {
	it.each([
		['a plain attachment', () => writeFileSync(join(report, 'data', 'a.txt'), `token ${JWT}`)],
		[
			'a deflated archive member',
			() => writeFileSync(join(report, 'data', 'a.zip'), makeZip({ 'x.json': `"${JWT}"` })),
		],
		[
			'the report data index.html embeds',
			() => {
				const embedded = makeZip({ 'report.json': JSON.stringify({ errors: [JWT] }) });
				writeFileSync(
					join(report, 'index.html'),
					`<script>x = "data:application/zip;base64,${embedded.toString('base64')}";</script>`
				);
			},
		],
	])('refuses one in %s', (_where, write) => {
		write();

		const findings = scanReport(report, { secrets: [], jwts: true });
		expect(findings.map((finding) => finding.label)).toContain(JWT_LABEL);
	});

	it('passes a report without one, and text that only looks a little like one', () => {
		writeFileSync(join(report, 'data', 'a.txt'), 'eyJhbGciOi.eyJzdWIi.sig and plain text');

		expect(scanReport(report, { secrets: [], jwts: true })).toEqual([]);
	});

	it('looks for none unless asked, so the value-only scan keeps its contract', () => {
		writeFileSync(join(report, 'data', 'a.txt'), JWT);

		expect(findSecretsInReport(report, [])).toEqual([]);
	});
});

describe('scanReport, trace archives', () => {
	it('refuses a trace archive, whatever it holds', () => {
		writeFileSync(join(report, 'data', 'abc.zip'), traceZip());

		expect(scanReport(report, { secrets: [], traces: true })).toEqual([
			{ file: join('data', 'abc.zip'), label: TRACE_LABEL },
		]);
	});

	it('refuses the trace viewer, which the reporter copies in only next to a trace', () => {
		mkdirSync(join(report, 'trace'));
		writeFileSync(join(report, 'trace', 'index.html'), '<html></html>');

		expect(scanReport(report, { secrets: [], traces: true })).toEqual([
			{ file: 'trace', label: TRACE_LABEL },
		]);
	});

	it('passes the archives a report without traces has', () => {
		const embedded = makeZip({ 'report.json': '{}', 'abc.json': '{}' });
		writeFileSync(
			join(report, 'index.html'),
			`<script>x = "data:application/zip;base64,${embedded.toString('base64')}";</script>`
		);
		mkdirSync(join(report, 'data', 'trace'));

		expect(scanReport(report, { secrets: [], traces: true, jwts: true })).toEqual([]);
	});
});

describe('withUrlHosts', () => {
	it('adds the host of each URL, so a report that names it in another scheme is caught', () => {
		const secrets = withUrlHosts([{ label: 'CONVEX_TEST_URL', value: `${CONVEX_URL}/` }]);
		expect(secrets).toContainEqual({
			label: 'CONVEX_TEST_URL host',
			value: 'dummy-deployment-7c1e.example.invalid',
		});

		writeFileSync(
			join(report, 'data', 'console.txt'),
			"WebSocket connection to 'wss://dummy-deployment-7c1e.example.invalid/api/sync' failed"
		);
		expect(findSecretsInReport(report, secrets)).toEqual([
			{ file: join('data', 'console.txt'), label: 'CONVEX_TEST_URL host' },
		]);
	});

	it('leaves a value that is no URL, and a loopback URL, as they are', () => {
		const secrets = [
			{ label: 'KEY', value: 'instance|0123abcd' },
			{ label: 'LOCAL', value: 'http://localhost:3000' },
		];
		expect(withUrlHosts(secrets)).toEqual(secrets);
	});
});

describe('storageStateSecrets', () => {
	it('lists each long cookie stored, decoded and as its unsigned token, and long localStorage values', () => {
		expect(storageStateSecrets(STORAGE_STATE)).toEqual([
			{
				label: 'session cookie better-auth.session_token',
				value: encodeURIComponent(SIGNED_COOKIE),
			},
			{ label: 'session cookie better-auth.session_token', value: SIGNED_COOKIE },
			{ label: 'session cookie better-auth.session_token token', value: SESSION_TOKEN },
			{ label: 'storage-state localStorage value', value: 'dummy-long-local-storage-value' },
		]);
	});

	it.each([['not json'], ['{}'], ['{"cookies":[{"name":"a","value":1}]}']])(
		'throws on %s rather than reading it as "no cookies"',
		(json) => {
			expect(() => storageStateSecrets(json)).toThrow();
		}
	);
});

describe('scan-report-secrets CLI, run credentials', () => {
	let state: string;

	beforeEach(() => {
		state = join(report, '..', `${report.split('/').pop()}-state.json`);
		writeFileSync(state, STORAGE_STATE);
	});

	afterEach(() => {
		rmSync(state, { force: true });
	});

	const run = (args: string[] = ['--storage-state', state]) =>
		spawnSync('bun', [CLI, report, ...args, 'CONVEX_TEST_URL'], {
			env: { ...process.env, CONVEX_TEST_URL: CONVEX_URL },
			encoding: 'utf8',
		});

	it('keeps a report that carries none of them', () => {
		writeFileSync(join(report, 'data', 'console.txt'), '+1.0s [log] signed in');

		const result = run();
		expect(result.status).toBe(0);
		expect(existsSync(report)).toBe(true);
	});

	it.each([
		['a session cookie from the storage state', SIGNED_COOKIE],
		['the bare session token', SESSION_TOKEN],
		['the deployment host', 'dummy-deployment-7c1e.example.invalid'],
		['a JWT', JWT],
	])('deletes a report holding %s, without printing it', (_what, value) => {
		writeFileSync(join(report, 'data', 'console.txt'), `leak: ${value}`);

		const result = run();
		expect(result.status).toBe(1);
		expect(existsSync(report)).toBe(false);
		expect(`${result.stdout}${result.stderr}`).not.toContain(value);
	});

	it('deletes a report holding a trace archive even without --storage-state', () => {
		writeFileSync(join(report, 'data', 'abc.zip'), traceZip());

		const result = run([]);
		expect(result.status).toBe(1);
		expect(existsSync(report)).toBe(false);
		expect(result.stderr).toContain(TRACE_LABEL);
	});

	it('deletes the report when the storage state cannot be read', () => {
		writeFileSync(state, 'not json');
		writeFileSync(join(report, 'data', 'console.txt'), 'clean');

		const result = run();
		expect(result.status).toBe(1);
		expect(existsSync(report)).toBe(false);
	});

	it('scans without cookies when the setup never saved a storage state', () => {
		rmSync(state);
		writeFileSync(join(report, 'data', 'console.txt'), 'clean');

		const result = run();
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('No storage state saved');
	});

	it('refuses a --storage-state without a path', () => {
		const result = spawnSync('bun', [CLI, report, '--storage-state'], { encoding: 'utf8' });
		expect(result.status).toBe(2);
	});
});
