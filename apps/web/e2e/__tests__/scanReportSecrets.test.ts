// @vitest-environment node
/**
 * The report gate the E2E workflow runs before uploading `playwright-report/`
 * (#1203 review): a known dummy secret must be found wherever a Playwright HTML
 * report can carry it (an attachment, a trace archive, the report data embedded
 * in index.html), and a clean report must pass.
 *
 * The archives come from `zipFixtures.ts`; the archive reader's own checks
 * are covered in `zipArchive.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSecretsInReport, findingId, secretForms } from '../scanReportSecrets';
import { endRecord, hiddenMemberZip, makeZip } from './zipFixtures';

const SECRET = { label: 'CONVEX_TEST_INSTANCE_SECRET', value: 'dummy-instance-secret-4f1c' };
/** Punctuation that every encoding treats differently. */
const PUNCTUATED = { label: 'PUNCTUATED', value: 'dummy-review/value+with=punctuation' };
const CLI = resolve(__dirname, '../scan-report-secrets.ts');

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

describe('findSecretsInReport, encoded forms', () => {
	const found = (content: string) => {
		writeFileSync(join(report, 'data', 'console.txt'), content);
		return findSecretsInReport(report, [PUNCTUATED]).map((finding) => finding.label);
	};
	const bytes = Buffer.from(PUNCTUATED.value);

	it.each([
		['base64', bytes.toString('base64')],
		['base64url', bytes.toString('base64url')],
		[
			'base64 at offset 1 in a longer value',
			Buffer.from(`u:${PUNCTUATED.value}`).toString('base64'),
		],
		[
			'base64 at offset 2 in a longer value',
			Buffer.from(`us:${PUNCTUATED.value}`).toString('base64'),
		],
		[
			'base64 at offset 0 in a longer value',
			Buffer.from(`use:${PUNCTUATED.value}!`).toString('base64'),
		],
		['URL-encoded', encodeURIComponent(PUNCTUATED.value)],
		['URL-encoded, lowercase hex', encodeURIComponent(PUNCTUATED.value).toLowerCase()],
		['JSON with an escaped slash', PUNCTUATED.value.replaceAll('/', '\\/')],
		[
			'\\u-escaped',
			[...PUNCTUATED.value]
				.map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
				.join(''),
		],
		[
			'\\u-escaped, uppercase hex',
			[...PUNCTUATED.value]
				.map((c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
				.join(''),
		],
	])('finds the secret %s', (_form, content) => {
		expect(found(`before ${content} after`)).toEqual([PUNCTUATED.label]);
	});

	it('does not match a fragment of the secret', () => {
		expect(found(PUNCTUATED.value.slice(1))).toEqual([]);
		expect(found(PUNCTUATED.value.slice(0, -1))).toEqual([]);
		expect(found(Buffer.from(PUNCTUATED.value.slice(0, 12)).toString('base64'))).toEqual([]);
	});

	it('matches only whole encodings, each long enough not to occur by chance', () => {
		for (const form of secretForms(PUNCTUATED.value)) {
			expect(form.length).toBeGreaterThanOrEqual(PUNCTUATED.value.length - 2);
		}
		// A short secret keeps its whole encodings but no base64 cores.
		expect(secretForms('abc').map(String)).not.toContain('YW');
	});

	it('finds the secret in a file name and in an archive member name', () => {
		writeFileSync(join(report, 'data', `${encodeURIComponent(PUNCTUATED.value)}.txt`), 'x');
		writeFileSync(
			join(report, 'data', 'trace.zip'),
			makeZip({ [`resources/${bytes.toString('base64url')}`]: 'x' })
		);

		const findings = findSecretsInReport(report, [PUNCTUATED]);
		expect(findings).toContainEqual({
			file: join('data', `${encodeURIComponent(PUNCTUATED.value)}.txt`),
			label: PUNCTUATED.label,
		});
		expect(findings).toContainEqual({
			file: `${join('data', 'trace.zip')}!resources/${bytes.toString('base64url')}`,
			label: PUNCTUATED.label,
		});
	});
});

describe('findSecretsInReport, failing closed', () => {
	it('flags a .zip that lacks the zip signature', () => {
		const archive = makeZip({ 'trace.network': 'x' });
		archive.write('BROK', 0);
		writeFileSync(join(report, 'data', 'trace.zip'), archive);

		expect(findSecretsInReport(report, [SECRET])).toEqual([
			{ file: join('data', 'trace.zip'), label: 'unreadable' },
		]);
	});

	it('flags a symlink, dangling or not, and still reports the readable files', () => {
		writeFileSync(join(report, 'data', 'console.txt'), SECRET.value);
		symlinkSync('missing', join(report, 'data', 'dangling'));
		symlinkSync(join(report, 'data', 'console.txt'), join(report, 'data', 'linked'));

		expect(findSecretsInReport(report, [SECRET])).toEqual(
			expect.arrayContaining([
				{ file: join('data', 'console.txt'), label: SECRET.label },
				{ file: join('data', 'dangling'), label: 'unreadable' },
				{ file: join('data', 'linked'), label: 'unreadable' },
			])
		);
	});

	it('flags archives nested past the depth it reads', () => {
		let archive = makeZip({ 'trace.network': 'x' });
		for (let level = 0; level < 3; level++) archive = makeZip({ 'inner.zip': archive });
		writeFileSync(join(report, 'data', 'outer.zip'), archive);

		expect(findSecretsInReport(report, [SECRET])).toEqual([
			expect.objectContaining({ label: 'unreadable' }),
		]);
	});
});

describe('scan-report-secrets CLI', () => {
	const run = (env: Record<string, string>) =>
		spawnSync('bun', [CLI, report, SECRET.label, PUNCTUATED.label], {
			env: { ...process.env, ...env },
			encoding: 'utf8',
		});

	it('keeps a clean report and exits 0', () => {
		writeFileSync(join(report, 'data', 'console.txt'), 'clean');

		const result = run({ [SECRET.label]: SECRET.value });
		expect(result.status).toBe(0);
		expect(existsSync(report)).toBe(true);
	});

	it('deletes the report and fails when a readable file holds a secret next to one it cannot read', () => {
		writeFileSync(join(report, 'data', 'console.txt'), SECRET.value);
		symlinkSync('missing', join(report, 'data', 'dangling'));

		const result = run({ [SECRET.label]: SECRET.value });
		expect(result.status).toBe(1);
		expect(existsSync(report)).toBe(false);
	});

	it('deletes a report it cannot read at all', () => {
		symlinkSync('missing', join(report, 'data', 'dangling'));

		const result = run({ [SECRET.label]: SECRET.value });
		expect(result.status).toBe(1);
		expect(existsSync(report)).toBe(false);
	});

	it('never prints a path, which may itself carry an encoded secret', () => {
		const encoded = Buffer.from(PUNCTUATED.value).toString('base64url');
		const file = join('data', `${encoded}.txt`);
		writeFileSync(join(report, file), PUNCTUATED.value);

		const result = run({ [PUNCTUATED.label]: PUNCTUATED.value });
		const output = `${result.stdout}${result.stderr}`;
		expect(result.status).toBe(1);
		expect(output).not.toContain(encoded);
		expect(output).not.toContain(PUNCTUATED.value);
		expect(output).toContain(findingId(file));
	});
});

/** Two deflated members, the dummy secret only in the second. */
function twoMemberZip(): Buffer {
	return makeZip({ 'trace.trace': '{"type":"context-options"}\n', 'trace.network': SECRET.value });
}

describe('findSecretsInReport, archives that misdescribe themselves', () => {
	it.each([0, 1])('fails closed when a two-member archive advertises %i members', (count) => {
		const zip = twoMemberZip();
		zip.writeUInt16LE(count, endRecord(zip) + 8);
		zip.writeUInt16LE(count, endRecord(zip) + 10);
		writeFileSync(join(report, 'data', 'trace.zip'), zip);

		expect(findSecretsInReport(report, [SECRET])).toEqual([
			{ file: join('data', 'trace.zip'), label: 'unreadable' },
		]);
		const result = spawnSync('bun', [CLI, report, SECRET.label], {
			env: { ...process.env, [SECRET.label]: SECRET.value },
			encoding: 'utf8',
		});
		expect(result.status).toBe(1);
		expect(existsSync(report)).toBe(false);
	});

	it.each([false, true])(
		'fails closed when a compressed span hides an unlisted member (descriptors: %s)',
		(descriptors) => {
			writeFileSync(join(report, 'data', 'trace.zip'), hiddenMemberZip(SECRET.value, descriptors));

			expect(findSecretsInReport(report, [SECRET])).toContainEqual({
				file: join('data', 'trace.zip'),
				label: 'unreadable',
			});
			const result = spawnSync('bun', [CLI, report, SECRET.label], {
				env: { ...process.env, [SECRET.label]: SECRET.value },
				encoding: 'utf8',
			});
			expect(result.status).toBe(1);
			expect(existsSync(report)).toBe(false);
		}
	);

	it('still finds a stored secret in the raw bytes of an archive it cannot read', () => {
		const zip = makeZip({ 'trace.network': SECRET.value }, 0);
		zip.writeUInt16LE(0, endRecord(zip) + 8);
		zip.writeUInt16LE(0, endRecord(zip) + 10);
		writeFileSync(join(report, 'data', 'trace.zip'), zip);

		expect(findSecretsInReport(report, [SECRET])).toEqual(
			expect.arrayContaining([
				{ file: join('data', 'trace.zip'), label: SECRET.label },
				{ file: join('data', 'trace.zip'), label: 'unreadable' },
			])
		);
	});
});

describe('scan-report-secrets CLI output', () => {
	it('never echoes the report directory, which may carry an encoded secret', () => {
		const encoded = encodeURIComponent(PUNCTUATED.value);
		const dir = join(report, encoded);
		mkdirSync(dir);
		writeFileSync(join(dir, 'console.txt'), PUNCTUATED.value);

		const result = spawnSync('bun', [CLI, dir, PUNCTUATED.label], {
			env: { ...process.env, [PUNCTUATED.label]: PUNCTUATED.value },
			encoding: 'utf8',
		});
		expect(result.status).toBe(1);
		expect(existsSync(dir)).toBe(false);
		expect(`${result.stdout}${result.stderr}`).not.toContain(encoded);
	});
});
