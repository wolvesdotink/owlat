/**
 * The `convex-deploy` run of an update, and what a run that failed did to
 * Convex.
 *
 * The CLI's exit status cannot tell. `docker compose run` fails the same way
 * when the deploy rejected the push (nothing changed in Convex) and when the
 * client lost the daemon while the deploy went on (`error waiting for
 * container: unexpected EOF`), or was cut off by its time limit. Only the
 * container's own state separates them, so the run is named and not removed
 * when it exits (no `--rm`, whose removal also drops the exit code), and the
 * updater removes it once it has read it.
 *
 * Anything short of proof of a rejection is treated as a deploy that may have
 * gone live. And a deploy that may still be running is stopped, and waited for,
 * before a rollback copies data back under it (rollback.ts).
 */
import { randomBytes } from 'node:crypto';
import { exec, OWLAT_DIR } from './http.js';
import { oneLine } from './rollout.js';

/**
 * The name of the deploy container of the update that took `snapshotId`, so
 * a rollback to that snapshot (in this process or after a restart) can find
 * the deploy and stop it. Without a snapshot the name only has to be unique.
 */
export function deployContainerName(snapshotId?: string): string {
	return `owlat-update-deploy-${snapshotId ?? randomBytes(6).toString('hex')}`;
}

/** The `compose` argv suffix that runs the deploy under `name`. */
export function deployRunArgs(name: string, noDeps: boolean): string[] {
	return [
		'--profile',
		'deploy',
		'run',
		'--name',
		name,
		...(noDeps ? ['--no-deps'] : []),
		'convex-deploy',
	];
}

const NO_SUCH_CONTAINER = /no such (container|object)/i;

/**
 * Exit codes of a process that ended on its own: from 126 up they mean the
 * command could not run, or a signal ended it (137 is SIGKILL, 143 SIGTERM).
 */
const OWN_FAILURE = (code: number) => code >= 1 && code <= 125;

/**
 * Whether a deploy whose run failed provably changed nothing: its container
 * was never created, or exited on its own with a failure. `cutOff` says the
 * updater stopped the run itself (its time limit).
 */
export async function failedDeploy(
	name: string,
	cutOff: boolean
): Promise<{ rejected: true } | { rejected: false; detail: string }> {
	// Whatever the container did after the updater stopped the run proves nothing.
	if (cutOff) return { rejected: false, detail: 'it was cut off by its time limit' };
	const inspected = await exec(
		'docker',
		[
			'inspect',
			'--type',
			'container',
			'--format',
			'{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}',
			name,
		],
		OWLAT_DIR
	);
	if (!inspected.ok) {
		// Never created, so it never pushed anything.
		if (NO_SUCH_CONTAINER.test(inspected.stderr)) return { rejected: true };
		return {
			rejected: false,
			detail: `its container could not be read (${oneLine(inspected.stderr)})`,
		};
	}
	const [status = '', code = '', oomKilled = ''] = inspected.stdout.trim().split('|');
	const exitCode = Number.parseInt(code, 10);
	if (status === 'exited' && oomKilled === 'false' && OWN_FAILURE(exitCode)) {
		return { rejected: true };
	}
	if (status === 'exited') {
		return {
			rejected: false,
			detail: `its container exited with code ${code}${oomKilled === 'true' ? ' (out of memory)' : ''}`,
		};
	}
	return { rejected: false, detail: `its container is ${status || 'in an unknown state'}` };
}

/**
 * Stop the deploy if it still runs, wait for it, and remove its container. A
 * container that is already gone counts as removed.
 */
export async function removeDeployContainer(
	name: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const removed = await exec('docker', ['rm', '--force', name], OWLAT_DIR);
	if (removed.ok || NO_SUCH_CONTAINER.test(removed.stderr)) return { ok: true };
	return { ok: false, reason: oneLine(removed.stderr) };
}
