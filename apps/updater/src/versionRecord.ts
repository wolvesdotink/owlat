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

/** Rewrite `<install dir>/VERSION` for `version`. Reported, never thrown. */
export async function recordRunningVersion(
	version: string,
	appliedBy: 'updater' | 'rollback'
): Promise<Step> {
	try {
		await writeVersionRecord(OWLAT_DIR, { version, appliedAt: new Date(), appliedBy });
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
 * without finishing `up` (interrupted, or `up` failed halfway): `.env` then
 * pins a release whose containers may never have been recreated, until the
 * next rollout settles it. Nothing to do on a `dev` stack or an unreadable
 * `.env`.
 */
export async function syncVersionRecord(): Promise<Step | null> {
	const last = readRecord();
	if (last?.committed && (last.outcome === 'interrupted' || last.outcome === 'partially-applied')) {
		return null;
	}
	const env = await readEnvFile(join(OWLAT_DIR, '.env')).catch(() => ({}) as EnvMap);
	const pinned = env['OWLAT_VERSION']?.trim() ?? '';
	if (!isReleaseVersion(pinned)) return null;
	const record = await readFile(join(OWLAT_DIR, VERSION_RECORD_FILE), 'utf-8').catch(() => null);
	if (record !== null && parseVersionRecordVersion(record) === pinned) return null;
	return recordRunningVersion(pinned, 'updater');
}
