import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	isReleaseVersion,
	parseVersionRecordVersion,
	writeVersionRecord,
} from '../installVersionRecord';

let dir = '';
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'owlat-version-record-'));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('the install VERSION record', () => {
	it('names the release, its tag and when it was recorded, under a note about the source tree', async () => {
		await writeVersionRecord(dir, {
			version: '0.6.24',
			recordedAt: new Date('2026-11-25T10:00:00.000Z'),
			appliedBy: 'updater',
		});
		const text = await readFile(join(dir, 'VERSION'), 'utf-8');
		expect(text.split('\n').filter((line) => !line.startsWith('#'))).toEqual([
			'version=0.6.24',
			'tag=v0.6.24',
			'recorded_at=2026-11-25T10:00:00.000Z',
			'applied_by=updater',
			'',
		]);
		expect(text).toContain('# https://github.com/wolvesdotink/owlat/tree/v0.6.24');
		expect(parseVersionRecordVersion(text)).toBe('0.6.24');
	});

	it('refuses a version no release tag carries, and writes nothing', async () => {
		expect(isReleaseVersion('1.2.3-rc.1')).toBe(true);
		for (const version of ['dev', 'latest', '', 'v1.2.3', '1.2.3\ntag=x']) {
			expect(isReleaseVersion(version)).toBe(false);
			await expect(
				writeVersionRecord(dir, { version, recordedAt: new Date(0), appliedBy: 'installer' })
			).rejects.toThrow('not a release version');
		}
		await expect(readFile(join(dir, 'VERSION'), 'utf-8')).rejects.toThrow();
	});
});
