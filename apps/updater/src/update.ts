/**
 * POST /update — apply a release to the running stack.
 *
 * The order is the whole design: validate the caller's template, prove the
 * Docker API can finish the job, make room on the disk, stage the template, pull, deploy the Convex
 * functions against the still-running old backend, and only then promote the
 * file and recreate the containers. Every one of those steps up to the promote
 * can fail leaving the running stack exactly as it was.
 *
 * The recreate is the exception, and the only step that can leave the instance
 * dark: there is no old state left to keep by then. It gets the other half of
 * the guarantee instead — when it fails, the stack is started back up and the
 * caller is told, in as many words, whether the instance is serving.
 *
 * A recreate that exits 0 has only STARTED the release. Success is reported
 * once the started services meet the readiness contract in readiness.ts, and
 * every answer from the recreate on carries a `rollout` state:
 *
 *   - `healthy`: `up` succeeded and every service passed the readiness check;
 *   - `started`: `up` succeeded, but the readiness check did not pass in time;
 *   - `partially-applied`: `up` failed and the stack was started forward again
 *     (there is no rollback: the old release's containers are gone by then).
 *
 * A service that was already failing before the update does not make the
 * rollout `started`; it comes back as a warning (readiness.ts). The verdict is
 * also written to the install directory for /health (rolloutState.ts), since
 * the web container that asked is normally recreated before the answer.
 *
 * Split out of server.ts, which also owns /health, /configure-ip and
 * /rotate-env (CONVENTIONS.md ~500 LOC rule). The rollout's own plumbing — the
 * preflight, the service list, the self-replacement hand-off — lives in
 * rollout.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '@owlat/shared';
import {
	applyEnvUpdates,
	isRateLimited,
	parseReleaseVersionFromTemplate,
	validateComposeTemplate,
} from './security.js';
import { exec, json, OWLAT_DIR, readBody, requireAuth } from './http.js';
import {
	composeArgv,
	dockerApiPreflight,
	recoverStackAfterFailedUp,
	scheduleUpdaterRecreateSafely,
	servicesToRecreate,
} from './rollout.js';
import { diskSpacePreflight, pullFailureMessage, reclaimUnusedImages } from './storage.js';
import { failingBeforeRollout, verifyReadiness } from './readiness.js';
import { writeLastRollout, type LastRollout, type RolloutOutcome } from './rolloutState.js';

interface UpdateAnswer {
	error?: string;
	rollout?: RolloutOutcome;
	[key: string]: unknown;
}

const COMPOSE_FILE = join(OWLAT_DIR, 'docker-compose.yml');

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
		await writeFile(envFile, rewrite.content, 'utf-8');
		return { ok: true, stdout: `OWLAT_VERSION pinned to ${version}`, stderr: '' };
	} catch (err) {
		return { ok: false, stdout: '', stderr: `Cannot update .env: ${errorMessage(err)}` };
	}
}

export async function handleUpdate(req: IncomingMessage, res: ServerResponse) {
	if (!requireAuth(req, res)) return;

	// Rate limit: max 2 updates per minute
	if (isRateLimited('update', 2, 60_000)) {
		return json(res, 429, { error: 'Too many update requests. Try again later.' });
	}

	let composeTemplate: string | undefined;

	try {
		const raw = await readBody(req);
		if (raw) {
			const body = JSON.parse(raw);
			composeTemplate = body.composeTemplate;
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
		targetVersion: composeTemplate ? parseReleaseVersionFromTemplate(composeTemplate) : null,
		startedAt: Date.now(),
		phase: 'applying',
	};
	writeLastRollout(record);
	const answer = (
		status: number,
		body: UpdateAnswer,
		verdict: { summary?: string; warnings?: string[] } = {}
	) => {
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

	// Step 2: Prove the Docker API will let this rollout finish before anything
	// is staged, pulled or deployed. The endpoints the socket proxy grants are
	// the one precondition an update cannot recover from halfway through, and
	// the failure it produced instead — a 403 surfacing as "convex-deploy
	// failed" — pointed the operator at the schema deploy, not at the sidecar.
	const preflight = dockerApiPreflight();
	steps.push(preflight);
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
	steps.push(reclaimUnusedImages());
	const disk = diskSpacePreflight();
	steps.push(disk);
	if (!disk.ok) {
		console.error('[update] refused before staging:', disk.stderr);
		return answer(507, { error: disk.stderr, steps });
	}

	// Step 3: STAGE the validated template. The live docker-compose.yml is only
	// replaced after pull + convex-deploy succeed — previously it was
	// overwritten first, so a failed update left a half-applied breaking
	// template behind that the next manual `docker compose up` would silently
	// complete.
	const STAGED_FILE = join(OWLAT_DIR, 'docker-compose.next.yml');
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
	const composeArgs = composeArgv([composeFileForUpdate]);
	const discardStaged = async () => {
		if (!composeTemplate) return;
		try {
			await rm(STAGED_FILE, { force: true });
		} catch {
			// best-effort cleanup
		}
	};

	// Step 4: Pull latest images (against the staged template, so a pull
	// failure leaves the running stack and its compose file untouched).
	const pull = exec('docker', [...composeArgs, 'pull'], OWLAT_DIR);
	steps.push({ step: 'pull', ...pull });

	if (!pull.ok) {
		await discardStaged();
		const error = pullFailureMessage(pull.stderr);
		console.error('[update]', error);
		return answer(500, { error, steps });
	}

	// Step 5 (P2.4 / S5): deploy Convex functions BEFORE restarting app
	// containers. If the new schema is incompatible with the deploy, we
	// bail out here — the running Web/MTA containers keep serving the old
	// (still compatible) code rather than being restarted against a half-
	// deployed backend.
	//
	// This requires the existing convex container to still be running at
	// its previous version, so the one-shot deployer can reach it.
	const deploy = exec(
		'docker',
		[...composeArgs, '--profile', 'deploy', 'run', '--rm', 'convex-deploy'],
		OWLAT_DIR
	);
	steps.push({ step: 'convex-deploy', ...deploy });

	if (!deploy.ok) {
		await discardStaged();
		return answer(500, {
			error: 'convex-deploy failed — update aborted, running stack untouched',
			steps,
		});
	}

	// Step 6: Promote the staged template now that pull + deploy succeeded.
	if (composeTemplate) {
		try {
			await writeFile(COMPOSE_FILE, composeTemplate, 'utf-8');
			await unlink(STAGED_FILE);
			steps.push({ step: 'write-compose', stdout: 'Compose file updated', stderr: '' });
		} catch (err) {
			return answer(500, {
				error: 'Failed to promote compose file',
				details: errorMessage(err),
				steps,
			});
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
	const plan = servicesToRecreate();
	if (plan.error) {
		steps.push({ step: 'up', ok: false, stdout: '', stderr: plan.error });
		return answer(500, { error: `docker compose up failed: ${plan.error}`, steps });
	}

	// What was already broken before the release touched it, so the verdict
	// can tell the rollout's failures from the stack's.
	const preExisting = failingBeforeRollout(plan.services, composeArgv());

	const up = exec(
		'docker',
		[...composeArgv(), 'up', '-d', '--remove-orphans', ...plan.services],
		OWLAT_DIR
	);
	steps.push({ step: 'up', ...up });

	if (!up.ok) {
		// The one failure in this handler that the running stack does NOT survive:
		// every earlier step is ordered so that failing it changes nothing, but by
		// the time `up` runs the release is pulled, deployed and promoted, and a
		// recreate that dies halfway leaves its services stopped. So there is
		// nothing to roll back to — recovery is to finish starting them.
		const recovery = await recoverStackAfterFailedUp(plan.services);
		steps.push(recovery);
		// In this sidecar's own log too. An operator whose instance just went dark
		// reads `docker logs owlat-updater-1` long before they think to re-trigger
		// the update to see a step list — and until now it said nothing at all.
		console.error('[update] `up` failed:', up.stderr);
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
	}

	// Step 9: `up` has started the release; wait (bounded, per the cadence each
	// service declares) until it is serving.
	writeLastRollout({ ...record, phase: 'verifying' });
	const readiness = await verifyReadiness(plan.services, composeArgv(), { preExisting });
	steps.push({
		step: 'readiness',
		ok: readiness.ready,
		stdout: readiness.ready ? readiness.summary : '',
		stderr: readiness.ready ? '' : readiness.summary,
	});
	if (!readiness.ready) console.error('[update] release started but not ready:', readiness.summary);

	// Step 10: Hand this container's own replacement to a helper that outlives
	// it, so the updater does not stay a release behind forever. Reported, never
	// fatal. It runs whether or not the readiness check passed: the new release
	// is promoted and running either way, and an updater left on the old image
	// is one more thing out of step with it.
	steps.push(scheduleUpdaterRecreateSafely());

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
