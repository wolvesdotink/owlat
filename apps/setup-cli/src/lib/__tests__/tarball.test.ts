import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTarGz, isSafeTarName } from '../tarball';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function extract(archive: Uint8Array): string {
	const dir = mkdtempSync(join(tmpdir(), 'tarball-'));
	dirs.push(dir);
	const file = join(dir, 'archive.tar.gz');
	writeFileSync(file, archive);
	execFileSync('tar', ['-xzf', file, '-C', dir]);
	return dir;
}

describe('createTarGz', () => {
	it('writes an archive the system tar extracts byte for byte', () => {
		const binary = Uint8Array.from({ length: 1500 }, (_, index) => index % 256);
		const archive = createTarGz(
			[
				{ name: 'bundle/manifest.json', content: '{"ok":true}\n' },
				{ name: 'bundle/logs/web.ndjson', content: 'ünïcode line\n' },
				{ name: 'bundle/blob.bin', content: binary },
				{ name: 'bundle/empty.txt', content: '' },
			],
			new Date('2026-10-24T10:00:00Z')
		);
		const dir = extract(archive);
		expect(readFileSync(join(dir, 'bundle/manifest.json'), 'utf8')).toBe('{"ok":true}\n');
		expect(readFileSync(join(dir, 'bundle/logs/web.ndjson'), 'utf8')).toBe('ünïcode line\n');
		expect(new Uint8Array(readFileSync(join(dir, 'bundle/blob.bin')))).toEqual(binary);
		expect(readFileSync(join(dir, 'bundle/empty.txt'), 'utf8')).toBe('');
		expect(statSync(join(dir, 'bundle/manifest.json')).mtime.toISOString()).toBe(
			'2026-10-24T10:00:00.000Z'
		);
	});

	it('refuses member names that could escape the extraction directory', () => {
		for (const name of [
			'../evil',
			'/etc/passwd',
			'a/../../b',
			'a//b',
			'a b',
			'x'.repeat(100),
			`a/${'x'.repeat(100)}`,
			`${'p'.repeat(155)}/x`,
			'',
		]) {
			expect(isSafeTarName(name)).toBe(false);
			expect(() => createTarGz([{ name, content: '' }], new Date(0))).toThrow(/unsafe/);
		}
		expect(isSafeTarName('owlat-support-20261024T100000Z/logs/convex.ndjson')).toBe(true);
	});

	it('splits a path longer than the name field into the ustar prefix', () => {
		// The longest member a bundle writes: a 64-character compose service name.
		const service = `s${'x'.repeat(63)}`;
		const name = `owlat-support-20261024T100000Z/logs/${service}.ndjson`;
		expect(name.length).toBeGreaterThan(100);
		expect(isSafeTarName(name)).toBe(true);
		const dir = extract(createTarGz([{ name, content: 'line\n' }], new Date(0)));
		expect(readFileSync(join(dir, name), 'utf8')).toBe('line\n');
	});

	it('refuses a duplicate member', () => {
		expect(() =>
			createTarGz(
				[
					{ name: 'a.json', content: '1' },
					{ name: 'a.json', content: '2' },
				],
				new Date(0)
			)
		).toThrow(/Duplicate/);
	});
});
