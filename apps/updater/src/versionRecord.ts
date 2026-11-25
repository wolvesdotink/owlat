/**
 * The install directory's VERSION file, rewritten as a step of a rollout once
 * the release it names is the one the host is configured to run.
 */
import { errorMessage } from '@owlat/shared';
import { writeVersionRecord } from '@owlat/shared/installVersionRecord';
import { OWLAT_DIR } from './http.js';

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
