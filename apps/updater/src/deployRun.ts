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
 * again (`removeUpdateContainers`).
 */
import { randomBytes } from 'node:crypto';
import { exec, OWLAT_DIR } from './http.js';
import { hostInstallDir, oneLine } from './rollout.js';

/**
 * Labels every container an update or a rollback starts (the deploy and the
 * snapshot's copy helpers) with the installation it works for. Several
 * installations can share a Docker daemon, each with its own rollout lock, so
 * a container left behind is found by this label and never by a name pattern
 * another installation's containers match too.
 */
export const UPDATE_INSTALL_LABEL = 'ink.wolves.owlat.update-install';

/**
 * Which installation this updater works for: its install directory as the
 * host sees it, which no two installations on one daemon share. An updater
 * outside a container sees the host path itself, and one whose install bind
 * cannot be read falls back to it the same way `composeArgv` does.
 */
export async function installationId(): Promise<string> {
	return (await hostInstallDir()) ?? OWLAT_DIR;
}

/**
 * The name of a deploy container, after the snapshot its update took when
 * there is one, so the operator can tell which update ran it.
 */
export function deployContainerName(snapshotId?: string): string {
	return `owlat-update-deploy-${snapshotId ?? randomBytes(6).toString('hex')}`;
}

/** The `compose` argv suffix that runs the deploy under `name` for `installation`. */
export function deployRunArgs(name: string, noDeps: boolean, installation: string): string[] {
	return [
		'--profile',
		'deploy',
		'run',
		'--name',
		name,
		'--label',
		`${UPDATE_INSTALL_LABEL}=${installation}`,
		...(noDeps ? ['--no-deps'] : []),
		'convex-deploy',
	];
}

const NO_SUCH_CONTAINER = /no such (container|object)/i;
/** Another `rm` (or a helper's own `--rm`) is already removing it. */
const REMOVAL_IN_PROGRESS = /removal of container .* is already in progress/i;

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
 * Stop the container if it still runs, wait for it, and remove it. A
 * container that is already gone counts as removed; one something else is
 * already removing is waited for until it has stopped.
 */
export async function removeContainer(
	name: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const removed = await exec('docker', ['rm', '--force', name], OWLAT_DIR);
	if (removed.ok || NO_SUCH_CONTAINER.test(removed.stderr)) return { ok: true };
	if (REMOVAL_IN_PROGRESS.test(removed.stderr)) {
		const waited = await exec('docker', ['wait', name], OWLAT_DIR);
		if (waited.ok || NO_SUCH_CONTAINER.test(waited.stderr)) return { ok: true };
		return { ok: false, reason: oneLine(waited.stderr) };
	}
	return { ok: false, reason: oneLine(removed.stderr) };
}

/**
 * Stop and remove every container an earlier update or rollback of this
 * installation left behind: a deploy a shutdown or a lost client left running
 * would push alongside the next deploy, and a copy helper would go on writing
 * under the next restore, both outside the rollout lock. Docker is asked by
 * label rather than the snapshot journal, since an update that took no
 * snapshot (`OWLAT_UPDATE_SNAPSHOT=off`) leaves no record of its deploy. Run
 * inside the lock, before anything starts a container of its own, so every
 * one it finds is stale. The updater's own replacement helper carries no such
 * label, so it is never among them.
 */
export async function removeUpdateContainers(): Promise<
	{ ok: true } | { ok: false; reason: string }
> {
	const installation = await installationId();
	const listed = await exec(
		'docker',
		[
			'ps',
			'--all',
			'--filter',
			`label=${UPDATE_INSTALL_LABEL}=${installation}`,
			'--format',
			'{{.Names}}',
		],
		OWLAT_DIR
	);
	if (!listed.ok) {
		return {
			ok: false,
			reason: `cannot list the update's containers: ${oneLine(listed.stderr)}`,
		};
	}
	const names = listed.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	for (const name of names) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
			return { ok: false, reason: `the container list holds a name that is not one (${name})` };
		}
		const removed = await removeContainer(name);
		if (!removed.ok) return { ok: false, reason: `${name}: ${removed.reason}` };
	}
	return { ok: true };
}
