/**
 * POST /update — apply a release to the running stack.
 *
 * The order is the whole design: validate the caller's template, prove the
 * Docker API can finish the job, make room on the disk, stage the template,
 * pull, snapshot the data and configuration, deploy the Convex functions
 * against the still-running old backend, and only then promote the file and
 * recreate the containers.
 *
 * The snapshot (snapshot.ts) is what makes the rest reversible. Until the new
 * release is confirmed ready, a deploy that failed once its container had
 * started (which cannot show that Convex rejected it, deployRun.ts), a
 * promote or recreate that failed, or a release that does not pass the
 * readiness check puts the stack back on it (rollback.ts) and answers
 * `rolled-back`. Once the release is confirmed
 * ready the snapshot is kept, and only the operator can restore it
 * (`owlat rollback`). Restoring discards what was written after the
 * snapshot, which is why it is never automatic after that point.
 *
 * A recreate that exits 0 has only STARTED the release. Success is reported
 * once the started services meet the readiness contract in readiness.ts, and
 * every answer from the recreate on carries a `rollout` state:
 *
 *   - `healthy`: `up` succeeded and every service passed the readiness check;
 *   - `rolled-back`: the release failed and the previous one is serving again;
 *   - `started`: `up` succeeded, but readiness was not confirmed and there was
 *     no snapshot to go back to (`OWLAT_UPDATE_SNAPSHOT=off`), or the updater
 *     stopped waiting because it is shutting down;
 *   - `partially-applied`: `up` failed without a snapshot, and the stack was
 *     started forward again;
 *   - `failed`: the rollback itself did not bring the previous release back.
 *
 * A service that was already failing before the update does not fail the
 * rollout; it comes back as a warning (readiness.ts). The verdict is also
 * written to the install directory for /health (rolloutState.ts), since the
 * web container that asked is normally recreated before the answer.
 *
 * A SIGTERM splits the handler at the promote. Before the deploy starts, the
 * rollout backs out: the Docker command in flight is stopped, the staged file
 * and the snapshot removed, and the verdict is `interrupted` with the running
 * stack unchanged. Once the deploy has started the backend may already run
 * the new functions, so a SIGTERM up to the promote stops without claiming
 * that: the staged file goes, the snapshot is kept for `owlat rollback`. From
 * the promote on it finishes `up` (the shutdown waits for it, see
 * lifecycle.ts), stops waiting for readiness, and says the release was
 * started but not confirmed. A process killed anyway leaves a record that is
 * still in flight, which the next start turns into an `interrupted` verdict
 * (`reconcileInterruptedUpdate`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { errorMessage } from '@owlat/shared';
import {
	isRateLimited,
	parseReleaseVersionFromTemplate,
	validateComposeTemplate,
} from './security.js';
import { exec, json, OWLAT_DIR, readBody, requireAuth, UPDATE_STEP_BOUNDS } from './http.js';
import { shutdownSignal } from './lifecycle.js';
import {
	composeArgv,
	dockerApiPreflight,
	servicesToRecreate,
	withOverrideFile,
} from './rollout.js';
import { diskSpacePreflight, pullFailureMessage, reclaimUnusedImages } from './storage.js';
import { failingBeforeRollout } from './readiness.js';
import { deployTarget } from './deployTarget.js';
import {
	deployContainerName,
	deployRunArgs,
	failedDeploy,
	removeContainer,
	removeUpdateContainers,
	resolveInstallation,
} from './deployRun.js';
import { discardSnapshot, markSnapshot, readSnapshot, type Snapshot } from './snapshot.js';
import { captureSnapshot, recoverInterruptedCapture } from './snapshotCapture.js';
import {
	applyRelease,
	COMPOSE_FILE,
	rollingBack,
	SNAPSHOT_KEPT,
	STAGED_FILE,
	type Answer,
} from './updateApply.js';
import {
	interruptedVerdict,
	isAttemptId,
	readRecord,
	writeLastRollout,
	type LastRollout,
} from './rolloutState.js';

/** The answer to a rollout that backed out because the updater is stopping. */
const BACKED_OUT =
	'The updater is shutting down, so the update stopped before the release was applied. ' +
	'The running stack was not changed; run the update again once the updater is back.';

/** The answer to a rollout the shutdown stopped after its deploy began. */
const STOPPED_AFTER_DEPLOY =
	'The updater is shutting down, and stopped the update after convex-deploy had started: the ' +
	'new Convex functions may be live while the other containers still run the previous release. ' +
	'Run the update again once the updater is back to bring the rest of the stack to the same release.';

/**
 * Settle an update the previous process never finished. Run once at startup,
 * before anything is served: nothing in this process can be running one yet.
 *
 * A record still in flight becomes an `interrupted` verdict on disk (it was
 * only ever reported as one), and the log says what it means for the stack;
 * a template the update had staged but not promoted is removed, so nothing
 * mistakes it for a release waiting to be applied.
 */
export async function reconcileInterruptedUpdate(): Promise<LastRollout | null> {
	await rm(STAGED_FILE, { force: true }).catch(() => {});
	await recoverInterruptedCapture().catch((err) =>
		console.error('[update] could not settle an interrupted snapshot:', err)
	);
	const record = readRecord();
	if (!record || record.phase === 'done') return null;

	// A snapshot taken by an update that never started its deploy describes
	// the stack as it still is. One whose deploy started (the journal records
	// it before the deploy runs, whatever the rollout record managed to say)
	// is what `owlat rollback` restores, and nothing rolls back to it on its
	// own any more.
	let note = '';
	const found = readSnapshot();
	const snapshot = found && found.takenAt >= record.startedAt ? found : null;
	if (snapshot?.state === 'armed' && !snapshot.deployStarted && !record.committed) {
		await discardSnapshot();
	} else if (snapshot?.state === 'armed' || snapshot?.state === 'kept') {
		if (snapshot.state === 'armed') {
			try {
				markSnapshot(snapshot, 'kept');
			} catch (err) {
				console.error('[update] could not record the snapshot as kept:', err);
			}
		}
		note = SNAPSHOT_KEPT;
	}

	const interrupted = interruptedVerdict({
		...record,
		deployStarted: record.deployStarted || snapshot?.deployStarted,
	});
	const verdict = {
		...interrupted,
		summary: `${interrupted.summary}${note}`,
		finishedAt: Date.now(),
	};
	writeLastRollout(verdict);
	console.error(
		`[update] the previous updater stopped during an update to ${record.targetVersion ?? 'the current release'}: ${verdict.summary}`
	);
	return verdict;
}

export async function handleUpdate(req: IncomingMessage, res: ServerResponse) {
	if (!requireAuth(req, res)) return;

	const stopping = shutdownSignal();
	if (stopping.aborted) {
		return json(res, 503, { error: 'The updater is shutting down. Try again once it is back.' });
	}

	// Rate limit: max 2 updates per minute
	if (isRateLimited('update', 2, 60_000)) {
		return json(res, 429, { error: 'Too many update requests. Try again later.' });
	}

	let composeTemplate: string | undefined;
	let attempt: string | undefined;

	try {
		const raw = await readBody(req);
		if (raw) {
			const body = JSON.parse(raw);
			composeTemplate = body.composeTemplate;
			// The caller's id for this attempt, echoed on /health so it can tell
			// this update's verdict from an earlier one's.
			if (isAttemptId(body.attempt)) attempt = body.attempt;
		}
	} catch {
		// No body or invalid JSON — proceed without compose template update
	}

	const steps: { step: string; ok?: boolean; stdout: string; stderr: string }[] = [];

	// Step 1: Validate the new compose template if provided. First, and without
	// touching Docker or the disk — a caller-supplied template is untrusted.
	if (composeTemplate) {
		const validation = validateComposeTemplate(composeTemplate);
		if (!validation.valid) {
			return json(res, 400, {
				error: 'Compose template validation failed',
				reason: validation.reason,
				steps,
			});
		}
	}

	// From here on every answer is also the last rollout's verdict (see the
	// header): the record says `applying` until one is reached.
	const record: LastRollout = {
		...(attempt ? { attempt } : {}),
		targetVersion: composeTemplate ? parseReleaseVersionFromTemplate(composeTemplate) : null,
		startedAt: Date.now(),
		phase: 'applying',
	};
	writeLastRollout(record);
	const answer: Answer = (status, body, verdict = {}) => {
		writeLastRollout({
			...record,
			phase: 'done',
			outcome: body.rollout ?? (status < 300 ? 'healthy' : 'failed'),
			summary: verdict.summary ?? body.error,
			warnings: verdict.warnings ?? [],
			finishedAt: Date.now(),
		});
		json(res, status, body);
	};

	// What an attempt that stops before the promote leaves behind: the staged
	// template, and a snapshot of a stack it never changed.
	let snapshot: Snapshot | null = null;
	const discardStaged = async () => {
		if (snapshot) {
			snapshot = null;
			await discardSnapshot().catch(() => {});
		}
		if (!composeTemplate) return;
		try {
			await rm(STAGED_FILE, { force: true });
		} catch {
			// best-effort cleanup
		}
	};
	// Every step before the deploy backs out on a SIGTERM (see the header).
	const backOut = async () => {
		await discardStaged();
		console.error('[update] stopped before the release was applied: the updater is shutting down');
		return answer(503, { error: BACKED_OUT, rollout: 'interrupted', steps });
	};
	// From the deploy to the promote it stops, but keeps the snapshot.
	const stopAfterDeploy = async () => {
		if (composeTemplate) await rm(STAGED_FILE, { force: true }).catch(() => {});
		let error = STOPPED_AFTER_DEPLOY;
		if (snapshot) {
			try {
				snapshot = markSnapshot(snapshot, 'kept');
			} catch (err) {
				console.error('[update] could not record the snapshot as kept:', err);
			}
			error += SNAPSHOT_KEPT;
		}
		console.error('[update] stopped after convex-deploy started: the updater is shutting down');
		return answer(503, { error, rollout: 'interrupted', steps });
	};

	// Step 2: Prove the Docker API will let this rollout finish before anything
	// is staged, pulled or deployed. The endpoints the socket proxy grants are
	// the one precondition an update cannot recover from halfway through, and
	// the failure it produced instead — a 403 surfacing as "convex-deploy
	// failed" — pointed the operator at the schema deploy, not at the sidecar.
	const preflight = await dockerApiPreflight(stopping);
	steps.push(preflight);
	if (stopping.aborted) return backOut();
	if (!preflight.ok) {
		// Also in this sidecar's own log: a refusal the operator can only read
		// by re-triggering the update is not much of an explanation.
		console.error('[update] refused before staging:', preflight.stderr);
		return answer(500, { error: preflight.stderr, steps });
	}

	// Step 2b: Make room for the release, then prove there is room. Nothing
	// ever removed a superseded release's images, so an instance that updated
	// often enough filled its disk, and the pull died with `no space left on
	// device` on every retry after. Reclaiming first lets exactly that instance
	// update itself out of the hole; the check after it turns a disk that is
	// full for some other reason into a sentence instead of a failed pull.
	steps.push(await reclaimUnusedImages(stopping));
	if (stopping.aborted) return backOut();
	const disk = diskSpacePreflight();
	steps.push(disk);
	if (!disk.ok) {
		console.error('[update] refused before staging:', disk.stderr);
		return answer(507, { error: disk.stderr, steps });
	}

	// Step 3: STAGE the validated template (see STAGED_FILE).
	let composeFileForUpdate = COMPOSE_FILE;
	if (composeTemplate) {
		try {
			await writeFile(STAGED_FILE, composeTemplate, 'utf-8');
			composeFileForUpdate = STAGED_FILE;
			steps.push({ step: 'stage-compose', stdout: 'New compose template staged', stderr: '' });
		} catch (err) {
			return answer(500, {
				error: 'Failed to stage compose file',
				details: errorMessage(err),
				steps,
			});
		}
	}
	// Every compose call names the project directory as the HOST sees it, so a
	// relative bind in the template resolves to the real file and not to a path
	// that only exists inside this container.
	//
	// The deploy also loads the override, so a convex it has to start (below)
	// runs as the install configured it. The pull does not: an override may pin
	// a locally built image no registry has.
	const composeArgs = await composeArgv([composeFileForUpdate]);
	const deployArgs = await composeArgv(withOverrideFile(composeFileForUpdate));
	if (stopping.aborted) return backOut();

	// Step 4: Pull latest images (against the staged template, so a pull
	// failure leaves the running stack and its compose file untouched).
	const pull = await exec('docker', [...composeArgs, 'pull'], OWLAT_DIR, {
		signal: stopping,
		timeoutMs: UPDATE_STEP_BOUNDS.pullMs,
	});
	steps.push({ step: 'pull', ...pull });
	if (stopping.aborted) return backOut();

	if (!pull.ok) {
		await discardStaged();
		const error = pullFailureMessage(pull.stderr);
		console.error('[update]', error);
		return answer(500, { error, steps });
	}

	// Step 4b: what was already broken before the release touched it, so the
	// verdict can tell the rollout's failures from the stack's. Read before the
	// snapshot pauses convex and redis.
	const baseline = await servicesToRecreate();
	const preExisting = baseline.error
		? new Map<string, string>()
		: await failingBeforeRollout(baseline.services, await composeArgv());

	// Step 4c: no deploy or copy helper an earlier update or rollback of this
	// installation left behind (a shutdown, a client that lost the daemon) may
	// keep running alongside this one, whether or not that update took a
	// snapshot, so it is stopped before anything else changes, and the update
	// is refused when it cannot be. Which containers are this installation's
	// is read once here and used for every container this update starts.
	const refuseEarly = async (error: string) => {
		await discardStaged();
		steps.push({ step: 'earlier-deploy', ok: false, stdout: '', stderr: error });
		console.error('[update] refused before deploying:', error);
		return answer(500, { error, steps });
	};
	const installation = await resolveInstallation();
	if (!installation.ok) {
		return refuseEarly(
			`Cannot tell which containers belong to this install, so an earlier update's could not be stopped (${installation.reason}). Nothing was changed.`
		);
	}
	const earlier = await removeUpdateContainers(installation.id);
	if (!earlier.ok) {
		return refuseEarly(
			`Cannot stop a container an earlier update started (${earlier.reason}). Nothing was changed.`
		);
	}

	// Step 4d: snapshot the data and configuration the rest of the rollout
	// changes (snapshot.ts). No snapshot, no update: without one a failed
	// release cannot be rolled back, unless `.env` opts out.
	const captured = await captureSnapshot({
		targetVersion: record.targetVersion,
		signal: stopping,
		installation: installation.id,
	});
	steps.push(captured.step);
	if (captured.kind === 'taken') snapshot = captured.snapshot;
	if (stopping.aborted) return backOut();
	if (captured.kind === 'refused') {
		await discardStaged();
		console.error('[update] refused before deploying:', captured.step.stderr);
		return answer(captured.status, { error: captured.step.stderr, steps });
	}

	// Step 5: deploy Convex functions BEFORE restarting app containers. If the
	// new schema is incompatible with the deploy, we bail out here — the
	// running Web/MTA containers keep serving the old (still compatible) code
	// rather than being restarted against a half-deployed backend. With a
	// snapshot the data is also put back, since a failed deploy cannot show
	// that Convex refused it (below).
	//
	// It deploys to the convex that is already serving, as it is — never one
	// `run` recreated first (deployTarget.ts).
	//
	// Stopping it on a SIGTERM is no worse than letting it finish: either way
	// the old containers keep serving, and the next update deploys again.
	const backend = await deployTarget('convex', deployArgs, stopping);
	if (stopping.aborted) return backOut();
	if (backend.kind === 'unavailable') {
		await discardStaged();
		const error = `convex is not serving — ${backend.detail}; update aborted, running stack untouched. Check \`docker compose logs convex\`, bring it back up, then retry.`;
		return answer(500, { error, steps });
	}
	const noDeps = backend.kind === 'serving';

	// From here the backend may run the new functions before anything else
	// changes, so a snapshot of this update is never discarded as describing an
	// untouched stack. The journal is fsynced first; the rollout record is
	// best-effort.
	if (snapshot) {
		try {
			snapshot = markSnapshot(snapshot, 'armed', { deployStarted: true });
		} catch (err) {
			await discardStaged();
			const error = `Cannot record the snapshot before convex-deploy: ${errorMessage(err)}. Nothing was changed.`;
			return answer(500, { error, steps });
		}
	}
	record.deployStarted = true;
	writeLastRollout(record);
	const rollBackOr = rollingBack({ record, steps, answer, snapshot, preExisting });

	// Labelled with this installation, so a rollback or the next update can
	// find and stop this deploy if it outlives this request (deployRun.ts).
	const deployName = deployContainerName(snapshot?.id);
	const deploy = await exec(
		'docker',
		[...deployArgs, ...deployRunArgs(deployName, noDeps, installation.id)],
		OWLAT_DIR,
		{
			signal: stopping,
			timeoutMs: UPDATE_STEP_BOUNDS.convexDeployMs,
		}
	);
	steps.push({ step: 'convex-deploy', ...deploy });
	// The deploy may still be running; `owlat rollback` stops it first.
	if (stopping.aborted) return stopAfterDeploy();

	if (!deploy.ok) {
		// Only a deploy that never started provably changed nothing in Convex.
		// Anything else (a push Convex refused, one it committed while the CLI
		// lost the answer, a run cut off by its bound, a client that lost the
		// daemon) may have gone live, against containers on the old release.
		const timedOut = deploy.stderr.includes('timed out after');
		const outcome = await failedDeploy(deployName, timedOut);
		if (outcome.unchanged) {
			await removeContainer(deployName);
			await discardStaged();
			return answer(500, {
				error:
					'convex-deploy failed before its container started — update aborted, running stack untouched',
				steps,
			});
		}
		const failure = timedOut
			? 'convex-deploy timed out, and the new functions might have gone live behind the old containers.'
			: `convex-deploy failed without showing whether it changed Convex (${outcome.detail}), and the new functions might have gone live behind the old containers.`;
		// Only the staged template goes: the snapshot is what the rollback
		// restores, and the rollback stops the deploy before it does.
		if (composeTemplate) await rm(STAGED_FILE, { force: true }).catch(() => {});
		return rollBackOr(failure, async () => {
			const stopped = await removeContainer(deployName);
			const error =
				(timedOut ? 'convex-deploy timed out' : `convex-deploy failed (${outcome.detail})`) +
				' — update aborted before any container was replaced, but the new functions may have gone live; ' +
				'run the update again to bring the rest of the stack to the same release' +
				(stopped.ok
					? ''
					: `. The deploy could not be stopped (${stopped.reason}): \`docker rm --force ${deployName}\` on the host stops it`);
			return answer(500, { error, steps });
		});
	}
	const cleaned = await removeContainer(deployName);
	if (!cleaned.ok) {
		console.error(
			`[update] could not remove the finished deploy container ${deployName}:`,
			cleaned.reason
		);
	}

	return applyRelease({ record, steps, answer, composeTemplate, snapshot, preExisting });
}
