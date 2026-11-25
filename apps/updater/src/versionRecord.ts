/**
 * The install directory's VERSION file, rewritten as a step of a rollout once
 * the release it names is the one the host is configured to run.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '@owlat/shared';
import { readEnvFile, type EnvMap } from '@owlat/shared/setupEnv';
import {
	isReleaseVersion,
	parseVersionRecordVersion,
	VERSION_RECORD_FILE,
	writeVersionRecord,
} from '@owlat/shared/installVersionRecord';
import { OWLAT_DIR } from './http.js';
import { readRecord } from './rolloutState.js';

type Step = { step: string; ok?: boolean; stdout: string; stderr: string };

/** The release `.env` pins, read as compose reads it; '' when there is none. */
async function pinnedVersion(): Promise<string> {
	const env = await readEnvFile(join(OWLAT_DIR, '.env')).catch(() => ({}) as EnvMap);
	return env['OWLAT_VERSION']?.trim() ?? '';
}

/**
 * Rewrite `<install dir>/VERSION` for the release `.env` pins once a rollout
 * or rollback has settled it. Read back from `.env`, never taken from what the
 * operation meant to apply: a pin that failed to write leaves the old release
 * in `.env`, and VERSION names what `.env` names. Null on a `dev` stack.
 * Reported, never thrown.
 */
export async function recordPinnedVersion(appliedBy: 'updater' | 'rollback'): Promise<Step | null> {
	const version = await pinnedVersion();
	if (!isReleaseVersion(version)) return null;
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
 * file. Not while the last rollout stopped after promoting its release
 * without finishing `up` (interrupted, `up` failed halfway, or failed before
 * `up` ran): `.env` then pins a release whose containers may never have been
 * recreated, until the next rollout settles it. Nothing to do on a `dev`
 * stack or an unreadable `.env`.
 */
const UNSETTLED_OUTCOMES: ReadonlySet<string> = new Set([
	'interrupted',
	'partially-applied',
	'failed',
]);

export async function syncVersionRecord(): Promise<Step | null> {
	const last = readRecord();
	if (last?.committed && last.outcome && UNSETTLED_OUTCOMES.has(last.outcome)) return null;
	const pinned = await pinnedVersion();
	if (!isReleaseVersion(pinned)) return null;
	const record = await readFile(join(OWLAT_DIR, VERSION_RECORD_FILE), 'utf-8').catch(() => null);
	if (record !== null && parseVersionRecordVersion(record) === pinned) return null;
	return recordPinnedVersion('updater');
}
