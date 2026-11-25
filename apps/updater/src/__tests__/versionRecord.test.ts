import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const OWLAT_DIR = mkdtempSync(join(tmpdir(), 'owlat-version-record-'));
process.env['OWLAT_DIR'] = OWLAT_DIR;
const { syncVersionRecord } = await import('../versionRecord.js');

const record = () => readFileSync(join(OWLAT_DIR, 'VERSION'), 'utf-8');

beforeEach(() => {
	rmSync(join(OWLAT_DIR, 'VERSION'), { force: true });
	writeFileSync(join(OWLAT_DIR, '.env'), 'FOO=bar\nOWLAT_VERSION=0.6.24\n');
});
afterAll(() => rmSync(OWLAT_DIR, { recursive: true, force: true }));

/**
 * The first update of an install that predates VERSION is applied by the
 * previous release's updater, which never writes the file; the updater it
 * hands over to writes it when it starts.
 */
describe('syncVersionRecord, at startup', () => {
	it('writes VERSION for the release .env pins on an install that has none', async () => {
		expect(await syncVersionRecord()).toMatchObject({ step: 'version-record', ok: true });
		expect(record()).toMatch(/^version=0\.6\.24$/m);
		expect(record()).toMatch(/^tag=v0\.6\.24$/m);
	});

	it('rewrites a VERSION that names another release', async () => {
		writeFileSync(join(OWLAT_DIR, 'VERSION'), 'version=0.4.19\n');
		await syncVersionRecord();
		expect(record()).toMatch(/^version=0\.6\.24$/m);
	});

	it('leaves a VERSION that already names the pinned release alone', async () => {
		writeFileSync(join(OWLAT_DIR, 'VERSION'), 'version=0.6.24\napplied_at=earlier\n');
		expect(await syncVersionRecord()).toBeNull();
		expect(record()).toBe('version=0.6.24\napplied_at=earlier\n');
	});

	it('writes nothing for a dev stack or without .env', async () => {
		writeFileSync(join(OWLAT_DIR, '.env'), 'OWLAT_VERSION=dev\n');
		expect(await syncVersionRecord()).toBeNull();
		rmSync(join(OWLAT_DIR, '.env'));
		expect(await syncVersionRecord()).toBeNull();
		expect(() => record()).toThrow();
	});
});
