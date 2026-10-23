/**
 * The `convex-deploy` run of an update, and what a run that failed did to
 * Convex.
 *
 * A failed run cannot show that Convex rejected the push. `docker compose run`
 * fails the same way when the client lost the daemon while the deploy went on
 * (`error waiting for container: unexpected EOF`) or was cut off by its time
 * limit, and the Convex CLI exits 1 both when the backend refused the push and
 * when it lost the answer to a push the backend had already committed. So the
 * only proof that nothing changed is a deploy container that never started:
 * the run is named and not removed when it exits (no `--rm`, which would leave
 * nothing to inspect), and the updater removes it once it has read it.
 *
 * Every other failure is treated as a deploy that may have gone live. A deploy
 * that may still be running is stopped, and waited for, before a rollback
 * copies data back under it (rollback.ts), and before the next update deploys
 * again (`removeEarlierDeploys`).
 */
import { randomBytes } from 'node:crypto';
import { exec, OWLAT_DIR } from './http.js';
import { oneLine } from './rollout.js';

/** Every deploy container an update runs is named with this prefix. */
const DEPLOY_PREFIX = 'owlat-update-deploy-';

/**
 * The name of the deploy container of the update that took `snapshotId`, so
 * a rollback to that snapshot (in this process or after a restart) can find
 * the deploy and stop it. Without a snapshot the name only has to be unique.
 */
export function deployContainerName(snapshotId?: string): string {
	return `${DEPLOY_PREFIX}${snapshotId ?? randomBytes(6).toString('hex')}`;
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
 * Whether a deploy whose run failed provably changed nothing: its container
 * was never created, or never started. `cutOff` says the updater stopped the
 * run itself (its time limit).
 */
export async function failedDeploy(
	name: string,
	cutOff: boolean
): Promise<{ unchanged: true } | { unchanged: false; detail: string }> {
	// Whatever the container did after the updater stopped the run proves nothing.
	if (cutOff) return { unchanged: false, detail: 'it was cut off by its time limit' };
	const inspected = await exec(
		'docker',
		['inspect', '--type', 'container', '--format', '{{.State.Status}}|{{.State.ExitCode}}', name],
		OWLAT_DIR
	);
	if (!inspected.ok) {
		// Never created, so it never pushed anything.
		if (NO_SUCH_CONTAINER.test(inspected.stderr)) return { unchanged: true };
		return {
			unchanged: false,
			detail: `its container could not be read (${oneLine(inspected.stderr)})`,
		};
	}
	const [status = '', code = ''] = inspected.stdout.trim().split('|');
	// Created but never started: the CLI inside never ran.
	if (status === 'created') return { unchanged: true };
	if (status === 'exited')
		return { unchanged: false, detail: `its container exited with code ${code}` };
	return { unchanged: false, detail: `its container is ${status || 'in an unknown state'}` };
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

/**
 * Stop and remove every deploy container an earlier update left behind: one a
 * shutdown or a lost client left running would otherwise push alongside the
 * next deploy, outside the rollout lock. Docker is asked rather than the
 * snapshot journal, since an update that took no snapshot
 * (`OWLAT_UPDATE_SNAPSHOT=off`) leaves no record of its deploy; `recorded`
 * names one the journal does know of, removed whatever the list says. Run
 * inside the lock, before the update's own deploy, so every container it finds
 * is stale.
 */
export async function removeEarlierDeploys(
	recorded: string[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const listed = await exec(
		'docker',
		['ps', '--all', '--filter', `name=${DEPLOY_PREFIX}`, '--format', '{{.Names}}'],
		OWLAT_DIR
	);
	if (!listed.ok) {
		return { ok: false, reason: `cannot list deploy containers: ${oneLine(listed.stderr)}` };
	}
	// The name filter matches anywhere in the name; only ours start with the prefix.
	const names = listed.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((name) => name.startsWith(DEPLOY_PREFIX));
	for (const name of new Set([...recorded, ...names])) {
		const removed = await removeDeployContainer(name);
		if (!removed.ok) return { ok: false, reason: `${name}: ${removed.reason}` };
	}
	return { ok: true };
}
