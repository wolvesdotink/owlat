/**
 * POST /update — apply a release to the running stack.
 *
 * The order is the whole design: validate the caller's template, prove the
 * Docker API can finish the job, stage the template, pull, deploy the Convex
 * functions against the still-running old backend, and only then promote the
 * file and recreate the containers. Every one of those steps can fail leaving
 * the running stack exactly as it was.
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
	composeCommand,
	dockerApiPreflight,
	scheduleUpdaterRecreateSafely,
	servicesToRecreate,
} from './rollout.js';

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
 * recreated containers are the ones that pick the new value up. A single
 * allowlisted key, appended when absent, through the same hardened rewriter the
 * secret rotation uses.
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
		return json(res, 500, { error: preflight.stderr, steps });
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
			return json(res, 500, {
				error: 'Failed to stage compose file',
				details: errorMessage(err),
				steps,
			});
		}
	}
	// Every compose call names the project directory as the HOST sees it, so a
	// relative bind in the template resolves to the real file and not to a path
	// that only exists inside this container.
	const composeCmd = composeCommand([composeFileForUpdate]);
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
	const pull = exec(`${composeCmd} pull`, OWLAT_DIR);
	steps.push({ step: 'pull', ...pull });

	if (!pull.ok) {
		await discardStaged();
		return json(res, 500, { error: 'Docker pull failed — update aborted, nothing changed', steps });
	}

	// Step 5 (P2.4 / S5): deploy Convex functions BEFORE restarting app
	// containers. If the new schema is incompatible with the deploy, we
	// bail out here — the running Web/MTA containers keep serving the old
	// (still compatible) code rather than being restarted against a half-
	// deployed backend.
	//
	// This requires the existing convex container to still be running at
	// its previous version, so the one-shot deployer can reach it.
	const deploy = exec(`${composeCmd} --profile deploy run --rm convex-deploy`, OWLAT_DIR);
	steps.push({ step: 'convex-deploy', ...deploy });

	if (!deploy.ok) {
		await discardStaged();
		return json(res, 500, {
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
			return json(res, 500, {
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
		return json(res, 500, { error: `docker compose up failed: ${plan.error}`, steps });
	}

	const up = exec(
		`${composeCommand()} up -d --remove-orphans ${plan.services.join(' ')}`,
		OWLAT_DIR
	);
	steps.push({ step: 'up', ...up });

	if (!up.ok) {
		return json(res, 500, { error: 'docker compose up failed', steps });
	}

	// Step 9: Hand this container's own replacement to a helper that outlives
	// it, so the updater does not stay a release behind forever. Reported, never
	// fatal — the release is already live on every other service.
	steps.push(scheduleUpdaterRecreateSafely());

	json(res, 200, { success: true, steps });
}
