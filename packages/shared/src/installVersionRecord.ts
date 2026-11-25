/**
 * The `VERSION` file in a self-hosted install directory: which release the
 * install is configured to run (the `OWLAT_VERSION` `.env` pins), its tag, and
 * when that was recorded.
 *
 * NODE-ONLY: uses `node:fs`. Exposed via the `@owlat/shared/installVersionRecord`
 * subpath ONLY; it must never be re-exported from the `.` barrel, which has to
 * stay browser-safe.
 *
 * The install directory is a git checkout of the release first installed, and
 * an update replaces `docker-compose.yml` and `.env`'s `OWLAT_VERSION` without
 * touching the checkout. Whoever reads the tree (an operator, or an agent with
 * shell access) would otherwise take the old source for the running code, so
 * the file says so at its top. Quickstart writes it once the stack is up; the
 * updater rewrites it after an update and after a rollback, and creates it on
 * an install that predates it.
 *
 * Plain `key=value` lines after the comment header, so a shell reads the
 * version with `sed -n 's/^version=//p' VERSION`.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const VERSION_RECORD_FILE = 'VERSION';

/** A release version as the image tags carry it: `1.2.3` or `1.2.3-rc.1`. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type VersionRecordWriter = 'installer' | 'updater' | 'rollback';

export interface VersionRecord {
	/** Bare release version, without the `v`. */
	version: string;
	recordedAt: Date;
	appliedBy: VersionRecordWriter;
}

/** Whether `version` names a published release (and so has a `v<version>` tag). */
export function isReleaseVersion(version: string): boolean {
	return RELEASE_VERSION.test(version);
}

function formatVersionRecord(record: VersionRecord): string {
	if (!isReleaseVersion(record.version)) {
		throw new Error(`not a release version: ${JSON.stringify(record.version)}`);
	}
	const tag = `v${record.version}`;
	return [
		'# The Owlat release this install is configured to run (OWLAT_VERSION in',
		'# .env). The installer writes this file, and the updater rewrites it after',
		'# every update and rollback.',
		'#',
		'# The source tree in this directory is the checkout this install started',
		'# from. Updates replace docker-compose.yml and .env, not the source, so the',
		'# code here can be older than the code that runs. The configured release:',
		`# https://github.com/wolvesdotink/owlat/tree/${tag}`,
		`version=${record.version}`,
		`tag=${tag}`,
		`recorded_at=${record.recordedAt.toISOString()}`,
		`applied_by=${record.appliedBy}`,
		'',
	].join('\n');
}

/** The `version=` a record names, or null when it names none. */
export function parseVersionRecordVersion(text: string): string | null {
	const match = /^version=(.*)$/m.exec(text);
	return match?.[1]?.trim() || null;
}

/** Write `<installDir>/VERSION`, replacing what was there. */
export async function writeVersionRecord(installDir: string, record: VersionRecord): Promise<void> {
	await writeFile(join(installDir, VERSION_RECORD_FILE), formatVersionRecord(record), 'utf-8');
}
