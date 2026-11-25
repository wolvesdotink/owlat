/**
 * The install directory's VERSION file, rewritten as a step of a rollout once
 * the release it names is the one the host is configured to run.
 */
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '@owlat/shared';
import { readEnvFile } from '@owlat/shared/setupEnv';
import {
	isReleaseVersion,
	parseVersionRecordVersion,
	VERSION_RECORD_FILE,
	writeVersionRecord,
} from '@owlat/shared/installVersionRecord';
import { OWLAT_DIR } from './http.js';

type Step = { step: string; ok?: boolean; stdout: string; stderr: string };

/**
 * The release `.env` pins, read as compose reads it; '' when it pins none, and
 * null when there is no `.env` to read, which says nothing about the pin.
 */
async function pinnedVersion(): Promise<string | null> {
	const path = join(OWLAT_DIR, '.env');
	if (!existsSync(path)) return null;
	const env = await readEnvFile(path).catch(() => null);
	return env ? (env['OWLAT_VERSION']?.trim() ?? '') : null;
}

const recordPath = () => join(OWLAT_DIR, VERSION_RECORD_FILE);

/**
 * Take away a VERSION that names a release while `.env` pins none (a `dev`
 * stack, or a snapshot from before the first pin that a rollback restored).
 * Null when there is no file.
 */
async function removeRecord(): Promise<Step | null> {
	if (!existsSync(recordPath())) return null;
	try {
		await rm(recordPath(), { force: true });
		return {
			step: 'version-record',
			ok: true,
			stdout: 'VERSION removed: .env pins no release',
			stderr: '',
		};
	} catch (err) {
		return {
			step: 'version-record',
			ok: false,
			stdout: '',
			stderr: `Cannot remove VERSION: ${errorMessage(err)}`,
		};
	}
}

/**
 * Bring `<install dir>/VERSION` in line with the release `.env` pins once a
 * rollout or rollback has changed it. Read back from `.env`, never taken from
 * what the operation meant to apply: a pin that failed to write leaves the old
 * release in `.env`, and VERSION names what `.env` names. When `.env` pins no
 * release the file is removed. Null when nothing was done. Reported, never
 * thrown.
 */
export async function recordPinnedVersion(appliedBy: 'updater' | 'rollback'): Promise<Step | null> {
	const version = await pinnedVersion();
	if (version === null) return null;
	if (!isReleaseVersion(version)) return removeRecord();
	try {
		await writeVersionRecord(OWLAT_DIR, { version, recordedAt: new Date(), appliedBy });
		return { step: 'version-record', ok: true, stdout: `VERSION names ${version}`, stderr: '' };
	} catch (err) {
		return {
			step: 'version-record',
			ok: false,
			stdout: '',
			stderr: `Cannot write VERSION: ${errorMessage(err)}`,
		};
	}
}

/**
 * Bring VERSION in line with the release `.env` pins, when it is missing or
 * names another. Run once at startup: the updater is recreated after every
 * update, and on the first update of an install that predates VERSION it is
 * the previous release's updater that applies it, which never writes the
 * file. Whatever the last rollout's outcome: VERSION names the release the
 * host is configured to run, which is what `.env` says, also while its
 * containers have yet to be recreated. Nothing to do without a readable
 * `.env`.
 */
export async function syncVersionRecord(): Promise<Step | null> {
	const pinned = await pinnedVersion();
	if (pinned === null) return null;
	if (!isReleaseVersion(pinned)) return removeRecord();
	const record = await readFile(recordPath(), 'utf-8').catch(() => null);
	if (record !== null && parseVersionRecordVersion(record) === pinned) return null;
	return recordPinnedVersion('updater');
}
