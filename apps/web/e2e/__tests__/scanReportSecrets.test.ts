// @vitest-environment node
/**
 * The report gate the E2E workflow runs before uploading `playwright-report/`
 * (#1203 review): a known dummy secret must be found wherever a Playwright HTML
 * report can carry it (an attachment, a trace archive, the report data embedded
 * in index.html), and a clean report must pass.
 *
 * The archives are built here in the zip layout Playwright writes (local
 * headers, central directory, deflate or stored members).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSecretsInReport, readZipEntries } from '../scanReportSecrets';

const SECRET = { label: 'CONVEX_TEST_INSTANCE_SECRET', value: 'dummy-instance-secret-4f1c' };

/** A zip archive; the reader ignores CRCs, so they are left at zero. */
function makeZip(files: Record<string, string | Buffer>, method: 0 | 8 = 8): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
		const data = method === 8 ? deflateRawSync(raw) : raw;
		const nameBytes = Buffer.from(name);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		locals.push(local, nameBytes, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);

		offset += local.length + nameBytes.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

/** A trace's network log line for a request, the shape Playwright records. */
function networkEntry(headers: Array<{ name: string; value: string }>): string {
	return `${JSON.stringify({
		type: 'resource-snapshot',
		snapshot: { request: { method: 'POST', url: 'https://example.invalid/seed/admin', headers } },
	})}\n`;
}

let report: string;

beforeEach(() => {
	report = mkdtempSync(join(tmpdir(), 'owlat-report-'));
	mkdirSync(join(report, 'data'));
});

afterEach(() => {
	rmSync(report, { recursive: true, force: true });
});

describe('findSecretsInReport', () => {
	it('passes a report that holds no secret', () => {
		writeFileSync(join(report, 'index.html'), '<html>report</html>');
		writeFileSync(join(report, 'data', 'console.txt'), '+1.0s [warning] markWelcomed failed');
		writeFileSync(
			join(report, 'data', 'trace.zip'),
			makeZip({ 'trace.network': networkEntry([{ name: 'Accept', value: '*/*' }]) })
		);

		expect(findSecretsInReport(report, [SECRET])).toEqual([]);
	});

	it('finds the secret in a plain attachment', () => {
		writeFileSync(join(report, 'data', 'console.txt'), `token=${SECRET.value}`);

		expect(findSecretsInReport(report, [SECRET])).toEqual([
			{ file: join('data', 'console.txt'), label: SECRET.label },
		]);
	});

	it.each([
		['deflated', 8],
		['stored', 0],
	] as const)('finds a request header inside a %s trace archive', (_kind, method) => {
		const trace = makeZip(
			{
				'trace.trace': '{"type":"context-options"}\n',
				'trace.network': networkEntry([{ name: 'X-Instance-Secret', value: SECRET.value }]),
			},
			method
		);
		writeFileSync(join(report, 'data', 'abc.zip'), trace);

		// A stored member is also readable in the archive's raw bytes, which is a
		// second finding for the same leak; the member-level one is what matters.
		expect(findSecretsInReport(report, [SECRET])).toContainEqual({
			file: `${join('data', 'abc.zip')}!trace.network`,
			label: SECRET.label,
		});
	});

	it('finds the secret in the report data index.html embeds as a base64 zip', () => {
		const embedded = makeZip({ 'report.json': JSON.stringify({ errors: [SECRET.value] }) });
		writeFileSync(
			join(report, 'index.html'),
			`<script>window.playwrightReportBase64 = "data:application/zip;base64,${embedded.toString('base64')}";</script>`
		);

		expect(findSecretsInReport(report, [SECRET])).toEqual([
			{ file: 'index.html#embedded-0!report.json', label: SECRET.label },
		]);
	});

	it('finds the secret in a zip nested inside another', () => {
		const inner = makeZip({ 'trace.network': networkEntry([{ name: 'X', value: SECRET.value }]) });
		writeFileSync(join(report, 'data', 'outer.zip'), makeZip({ 'inner.zip': inner }, 0));

		expect(findSecretsInReport(report, [SECRET])).toEqual([
			{ file: `${join('data', 'outer.zip')}!inner.zip!trace.network`, label: SECRET.label },
		]);
	});

	it('finds a secret that JSON escaping changed', () => {
		const quoted = { label: 'QUOTED', value: 'a"b\\c' };
		writeFileSync(join(report, 'data', 'trace.json'), JSON.stringify({ value: quoted.value }));

		expect(findSecretsInReport(report, [quoted])).toEqual([
			{ file: join('data', 'trace.json'), label: 'QUOTED' },
		]);
	});

	it('flags an archive it cannot read instead of passing it unchecked', () => {
		const broken = makeZip({ 'trace.network': 'x' }).subarray(0, 40);
		writeFileSync(join(report, 'data', 'broken.zip'), broken);

		expect(findSecretsInReport(report, [SECRET])).toEqual([
			{ file: join('data', 'broken.zip'), label: 'unreadable' },
		]);
	});

	it('ignores a secret that is not set', () => {
		writeFileSync(join(report, 'data', 'console.txt'), 'anything');

		expect(findSecretsInReport(report, [{ label: 'UNSET', value: '' }])).toEqual([]);
	});
});

describe('readZipEntries', () => {
	it('reads deflated and stored members back', () => {
		for (const method of [0, 8] as const) {
			const entries = readZipEntries(makeZip({ a: 'alpha', 'b/c': 'beta' }, method));
			expect(entries.map((entry) => [entry.name, entry.data.toString()])).toEqual([
				['a', 'alpha'],
				['b/c', 'beta'],
			]);
		}
	});
});
