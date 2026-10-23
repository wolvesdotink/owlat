/**
 * The half of POST /update that changes what the host runs: everything from
 * the promote on (update.ts has the whole sequence and why it is ordered so).
 * From here until the release is confirmed ready, a failure goes back to the
 * snapshot taken before the deploy when there is one (rollback.ts).
 */
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '@owlat/shared';
import { writeOwnerOnlyFile } from '@owlat/shared/ownerOnlyFile';
import { applyEnvUpdates, parseReleaseVersionFromTemplate } from './security.js';
import { exec, OWLAT_DIR } from './http.js';
import {
	composeArgv,
	recoverStackAfterFailedUp,
	scheduleUpdaterRecreateSafely,
	servicesToRecreate,
} from './rollout.js';
import { verifyReadiness } from './readiness.js';
import { markSnapshot, type Snapshot } from './snapshot.js';
import { rollBack, rollbackAnswer } from './rollback.js';
import { writeLastRollout, type LastRollout, type RolloutOutcome } from './rolloutState.js';

interface UpdateAnswer {
	error?: string;
	rollout?: RolloutOutcome;
	[key: string]: unknown;
}

/** Answer the request, recording the answer as the rollout's verdict. */
export type Answer = (
	status: number,
	body: UpdateAnswer,
	verdict?: { summary?: string; warnings?: string[] }
) => void;

type Step = { step: string; ok?: boolean; stdout: string; stderr: string };

export const COMPOSE_FILE = join(OWLAT_DIR, 'docker-compose.yml');

/**
 * Where a caller's template waits until pull and convex-deploy have succeeded.
 * The live docker-compose.yml is only replaced after both — it used to be
 * overwritten first, so a failed update left a half-applied breaking template
 * behind that the next manual `docker compose up` would silently complete.
 */
export const STAGED_FILE = join(OWLAT_DIR, 'docker-compose.next.yml');

/**
 * Move `.env`'s `OWLAT_VERSION` pin to the release we are applying.
 *
 * `.env` is what compose interpolates, so this one line is the CONFIGURED
 * version of the whole deployment: the web container reports it as the running
 * version (Settings → System & Updates, and the `versionFrom` of the next
 * update), `owlat doctor` and /health diff it against the running containers to
 * decide whether anything still needs recreating, and the locally built
 * sidecars take their image tag from it. Nothing else in the update path writes
 * it — so while this was missing, a SUCCESSFUL update left the dashboard
 * insisting the old version was still installed, with the same update still
 * "available", and /health reporting permanent version drift.
 *
 * Called after the compose file is promoted and before `up -d`, so the
 * recreated containers are the ones that pick the new value up. That only
 * holds because the compose children run without an `OWLAT_VERSION` of their
 * own (`COMPOSE_SHADOWED_VARS` in http.ts): compose reads its OWN environment
 * before `--env-file`, and the updater is a service in the very file it is
 * applying, so for three releases it handed compose the version it was created
 * at and this pin reached nothing the rollout recreated.
 *
 * A single allowlisted key, appended when absent, through the same hardened
 * rewriter the secret rotation uses.
 */
async function pinConfiguredVersion(
	version: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const envFile = join(OWLAT_DIR, '.env');
	try {
		const content = await readFile(envFile, 'utf-8');
		const rewrite = applyEnvUpdates(content, { OWLAT_VERSION: version }, ['OWLAT_VERSION'], {
			appendMissing: true,
		});
		if (!rewrite.ok) {
			return { ok: false, stdout: '', stderr: rewrite.reason };
		}
		await writeOwnerOnlyFile(envFile, rewrite.content);
		return { ok: true, stdout: `OWLAT_VERSION pinned to ${version}`, stderr: '' };
	} catch (err) {
		return { ok: false, stdout: '', stderr: `Cannot update .env: ${errorMessage(err)}` };
	}
}

interface RollbackContext {
	record: LastRollout;
	steps: Step[];
	answer: Answer;
	snapshot: Snapshot | null;
	preExisting: Map<string, string>;
}

/**
 * Answer a failure before the release is confirmed ready: roll back to the
 * snapshot when there is one, otherwise take `fallback`.
 */
export function rollingBack(ctx: RollbackContext) {
	const { record, steps, answer, snapshot, preExisting } = ctx;
	return async (failure: string, fallback: () => void | Promise<void>): Promise<void> => {
		if (!snapshot) return fallback();
		writeLastRollout({ ...record, phase: 'rolling-back' });
		console.error('[update] rolling back:', failure);
		const rollback = await rollBack(snapshot, preExisting);
		steps.push(...rollback.steps);
		const error = rollbackAnswer(snapshot, failure, rollback);
		if (!rollback.ok) console.error('[update]', error);
		const rollout: RolloutOutcome = rollback.ok ? 'rolled-back' : 'failed';
		return answer(
			500,
			{ error, rollout, warnings: rollback.warnings, steps },
			{ warnings: rollback.warnings }
		);
	};
}

export async function applyRelease(
	ctx: RollbackContext & { composeTemplate: string | undefined }
): Promise<void> {
	const { record, steps, answer, composeTemplate, preExisting } = ctx;
	let snapshot = ctx.snapshot;
	const rollBackOr = rollingBack(ctx);

	// The line a SIGTERM no longer backs out across: from here the rollout
	// changes what the host is configured to run, and finishing `up` is what
	// keeps the containers in line with it. Recorded first, so a process that
	// is killed anyway leaves a record saying which side of the line it was on.
	record.committed = true;
	writeLastRollout(record);

	// Step 6: Promote the staged template now that pull + deploy succeeded.
	if (composeTemplate) {
		try {
			await writeFile(COMPOSE_FILE, composeTemplate, 'utf-8');
			await unlink(STAGED_FILE);
			steps.push({ step: 'write-compose', stdout: 'Compose file updated', stderr: '' });
		} catch (err) {
			const details = errorMessage(err);
			return rollBackOr(`Failed to promote compose file (${details}).`, () =>
				answer(500, { error: 'Failed to promote compose file', details, steps })
			);
		}

		// Step 7: Move the configured version with the compose file it belongs
		// to. Not fatal on failure: the promoted template pins every image by
		// digest, so `up -d` still deploys the right bytes — the cost is a
		// dashboard that misreports the installed version, which the recorded
		// step makes visible instead of silent.
		const version = parseReleaseVersionFromTemplate(composeTemplate);
		if (version) {
			steps.push({ step: 'pin-version', ...(await pinConfiguredVersion(version)) });
		}
	}

	// Step 8: Apply — recreate changed containers now that the schema is live.
	// Runs against the promoted docker-compose.yml (+ any override file and
	// COMPOSE_PROFILES from .env, so profile-gated feature services update too),
	// naming every service EXCEPT the two the rollout itself runs through: an
	// unqualified `up` recreates the updater and the Docker socket proxy too,
	// and stopping either one kills the compose command issuing the rollout.
	const plan = await servicesToRecreate();
	if (plan.error) {
		steps.push({ step: 'up', ok: false, stdout: '', stderr: plan.error });
		return rollBackOr(`docker compose up failed: ${plan.error}.`, () =>
			answer(500, { error: `docker compose up failed: ${plan.error}`, steps })
		);
	}

	// No signal: a recreate cut short is what leaves services stopped.
	const compose = await composeArgv();
	const up = await exec(
		'docker',
		[...compose, 'up', '-d', '--remove-orphans', ...plan.services],
		OWLAT_DIR
	);
	steps.push({ step: 'up', ...up });

	if (!up.ok) {
		// In this sidecar's own log too: an operator whose instance just went dark
		// reads `docker logs owlat-updater-1` long before the step list.
		console.error('[update] `up` failed:', up.stderr);
		// A recreate that dies halfway leaves its services stopped. With a
		// snapshot the stack goes back to it; without one, recovery is to finish
		// starting the release that was promoted.
		return rollBackOr('docker compose up failed while recreating the containers.', async () => {
			const recovery = await recoverStackAfterFailedUp(plan.services);
			steps.push(recovery);
			console.error(
				`[update] recovery ${recovery.ok ? 'succeeded' : 'failed'}:`,
				recovery.ok ? recovery.stdout : recovery.stderr
			);
			return answer(500, {
				error: recovery.ok
					? 'docker compose up failed — the stack was restarted and is serving again, ' +
						'but the release may be only partly applied. Re-run the update.'
					: `docker compose up failed and the stack is not fully running. ${recovery.stderr}`,
				rollout: 'partially-applied' satisfies RolloutOutcome,
				steps,
			});
		});
	}

	// Step 9: `up` has started the release; wait (bounded, per the cadence each
	// service declares) until it is serving.
	writeLastRollout({ ...record, phase: 'verifying' });
	const readiness = await verifyReadiness(plan.services, compose, { preExisting });
	steps.push({
		step: 'readiness',
		ok: readiness.ready,
		stdout: readiness.ready ? readiness.summary : '',
		stderr: readiness.ready ? '' : readiness.summary,
	});
	if (!readiness.ready) console.error('[update] release started but not ready:', readiness.summary);

	if (!readiness.ready && !readiness.interrupted && snapshot) {
		return rollBackOr(
			`The release's containers started, but the stack did not pass the readiness check. ${readiness.summary}`,
			() => undefined
		);
	}

	// Confirmed ready: from here nothing rolls back on its own (see the header).
	// Recorded before the updater hands itself over, so its replacement never
	// mistakes a confirmed release for one still on trial.
	if (readiness.ready && snapshot) {
		try {
			snapshot = markSnapshot(snapshot, 'kept');
		} catch (err) {
			console.error('[update] could not record the release as confirmed:', err);
		}
	}

	// Step 10: Hand this container's own replacement to a helper that outlives
	// it, so the updater does not stay a release behind forever. Reported, never
	// fatal. It runs whether or not the readiness check passed: the new release
	// is promoted and running either way, and an updater left on the old image
	// is one more thing out of step with it.
	steps.push(await scheduleUpdaterRecreateSafely());

	if (readiness.interrupted) {
		const kept = snapshot
			? ' The snapshot taken before the update is kept: `owlat rollback` on the host restores it.'
			: '';
		return answer(
			503,
			{
				error:
					'The release was applied and its containers started, but the updater is shutting ' +
					`down and stopped checking whether they are serving. ${readiness.summary} Check ` +
					`\`docker compose ps\` on the host.${kept}`,
				rollout: 'started' satisfies RolloutOutcome,
				warnings: readiness.warnings,
				steps,
			},
			{ warnings: readiness.warnings }
		);
	}

	if (!readiness.ready) {
		return answer(
			500,
			{
				error:
					'The release was applied and its containers started, but the stack did not pass the ' +
					`readiness check. ${readiness.summary} Check \`docker compose ps\` and the logs of the ` +
					'services named above on the host.',
				rollout: 'started' satisfies RolloutOutcome,
				warnings: readiness.warnings,
				steps,
			},
			{ warnings: readiness.warnings }
		);
	}

	answer(
		200,
		{
			success: true,
			rollout: 'healthy' satisfies RolloutOutcome,
			warnings: readiness.warnings,
			steps,
		},
		{ summary: readiness.summary, warnings: readiness.warnings }
	);
}
