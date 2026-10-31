/**
 * The backend half of `owlat-setup quickstart`: turning the freshly booted,
 * empty Convex backend into a working deployment, and confirming the built-in
 * MTA's outbound identity before the install is called done.
 */

import { log } from '@clack/prompts';
import pc from 'picocolors';
import { readEnv, writeEnv } from '../lib/env';
import { waitForUrl } from '../lib/dockerHealth';
import {
	generateConvexAdminKey,
	deployConvexFunctions,
	setConvexEnvVars,
	selectRuntimeEnvVars,
	looksLikeRealAdminKey,
} from '../lib/convexDeploy';
import { progressSpinner, SetupStep, type Reporter } from '../lib/progress';
import { resolveLocalHost } from '../lib/localHost';
import type { ProvisioningCheckpoint } from '../lib/provisioningCheckpoint';
import { probeMtaIdentityHealth } from './doctor';
import { createDoctorRedactor } from '../lib/doctorText';
import {
	plannedOutboundIdentities,
	reverseDnsInstructions,
	checkReverseDns,
} from '../lib/reverseDns';
import { reapplyEnvToRunningStack } from './quickstartStack';

/**
 * A direct-delivery install is not complete until the MTA's own live
 * validator confirms every configured IP. The worker is already fail-closed,
 * so bringing the container up to perform this probe cannot leak a send.
 * Reports the outcome (and on failure ends the run's report) itself.
 */
export async function verifyMtaIdentity(
	envAfterCompose: Record<string, string>,
	reporter: Reporter
): Promise<boolean> {
	const localMtaUrl = `http://${resolveLocalHost(process.env)}:${envAfterCompose['MTA_HTTP_PORT'] ?? '3100'}`;
	reporter.step(SetupStep.MtaIdentity, 'Verifying outbound IP identity');
	// The MTA finishes its boot-time identity, source-address and DNSBL
	// sweeps before it opens the listener, and each sweep may wait on DNS
	// and a bounded Convex alert. Allow for all of that before giving up.
	try {
		await waitForUrl({ url: `${localMtaUrl}/health`, timeoutMs: 120_000 });
	} catch (err) {
		reporter.fail(
			`MTA health endpoint did not become ready: ${(err as Error).message}. Inspect it with \`docker compose logs mta\`.`
		);
		reporter.done(false);
		return false;
	}
	// Pass the master key so the probe can force a live re-check rather than
	// read the boot sweep's stored verdict: an operator who fixed their PTR
	// after the first attempt re-runs quickstart, and `docker compose up -d`
	// does not restart an unchanged MTA container to re-observe it.
	const identityFindings = await probeMtaIdentityHealth(
		localMtaUrl,
		envAfterCompose['MTA_API_KEY']
	);
	const redact = createDoctorRedactor(envAfterCompose);
	for (const finding of identityFindings) {
		const message = redact(finding.message);
		reporter.log(`${finding.ok ? '✓' : '✗'} ${message}`, finding.ok ? 'stdout' : 'stderr');
		if (finding.ok) log.success(message);
		else log.error(message);
	}
	const failedIdentity = identityFindings.find((finding) => !finding.ok);
	if (failedIdentity) {
		// Spell the fix out again rather than leaving the operator with one
		// `FCrDNS blocked` line: the record lives at the hosting provider, and
		// the run that just stopped resumes from its checkpoint once it is live.
		const lines = reverseDnsInstructions(
			await checkReverseDns(plannedOutboundIdentities(envAfterCompose), envAfterCompose)
		);
		if (lines.length === 0) {
			// This process resolves the records correctly, yet the MTA — which was
			// just asked to re-observe — still refuses. What differs is the
			// resolver: its cache is holding the previous answer, and a PTR TTL
			// runs to a day. Restarting the container is what clears it.
			lines.push(
				'Reverse DNS resolves correctly from the installer, but the MTA still reports the old verdict — its DNS resolver is holding the previous answer.',
				'Run `docker compose restart mta`, then re-run this install.'
			);
		}
		for (const line of lines) {
			log.warn(line);
			reporter.log(line, 'stderr');
		}
		log.info(
			`Re-run ${pc.cyan('owlat quickstart')} once the PTR record resolves — provisioning resumes where it stopped.`
		);
		reporter.fail(redact(failedIdentity.message));
		reporter.done(false);
		return false;
	}
	reporter.ok('Every outbound IP passed FCrDNS readiness');
	return true;
}

/**
 * Turn the EMPTY freshly-booted backend into a working deployment:
 *   1. mint the backend admin key (if not already real) and persist to .env
 *   2. deploy apps/api functions + schema + http routes
 *   3. push the function-runtime env vars into the deployment
 *
 * Steps 2–3 run through the `convex-deploy` container, which reads the admin
 * key from .env (compose interpolation) — hence step 1 writes it first.
 *
 * Seeding does NOT change what happens here: demo content for a real install
 * goes through `POST /sample-data/install`, so nothing has to flip
 * `OWLAT_DEV_MODE` (which would also unlock `POST /dev/reset` and disable
 * BetterAuth rate limiting on a production instance).
 */
export async function deployBackend(
	owlatDir: string,
	envPath: string,
	reporter: Reporter,
	buildLocal: boolean,
	checkpoint: ProvisioningCheckpoint,
	composeProfiles: string[]
): Promise<number> {
	const s = progressSpinner();

	// 1. Admin key — must be issued by the running backend.
	let env = await readEnv(envPath);
	reporter.step(SetupStep.AdminKey, 'Minting the Convex admin key');
	if (!looksLikeRealAdminKey(env['CONVEX_ADMIN_KEY'])) {
		s.start('Generating Convex admin key from the backend');
		try {
			const key = await generateConvexAdminKey(owlatDir);
			env = { ...env, CONVEX_ADMIN_KEY: key };
			await writeEnv(envPath, env);
			s.stop(pc.green('Admin key generated and saved to .env'));
			await reapplyEnvToRunningStack(owlatDir, composeProfiles);
			reporter.ok();
		} catch (e) {
			s.stop(pc.red(`Could not generate admin key: ${(e as Error).message}`));
			reporter.fail((e as Error).message);
			return 1;
		}
	} else {
		reporter.skip('already present in .env');
	}
	await checkpoint.complete('admin-key');

	// 2. Deploy functions.
	reporter.step(SetupStep.DeployFunctions, 'Deploying backend functions');
	if (checkpoint.isComplete('deploy-functions')) {
		reporter.skip('completed in an earlier run');
	} else {
		s.start('Deploying Convex functions (apps/api) — first run pulls/builds the deployer image');
		try {
			// buildLocal: the deployer image is built from source here; the later
			// env-set call reuses it (compose only pulls when the image is missing).
			await deployConvexFunctions(
				owlatDir,
				(line) => {
					s.message(line.slice(0, 80));
					reporter.log(line);
				},
				buildLocal
			);
			s.stop(pc.green('Convex functions deployed'));
			reporter.ok();
			await checkpoint.complete('deploy-functions');
		} catch (e) {
			s.stop(pc.red(`${(e as Error).message}`));
			reporter.fail((e as Error).message);
			return 1;
		}
	}

	// 3. Push function-runtime env vars into the deployment. This is also the
	// reseed step for secrets sealed at rest in the `.env` backup (envsealed:v1:…
	// tokens, e.g. the SMTP relay password written by the in-app transport
	// editor): `selectRuntimeEnvVars` unseals them so the deployment receives the
	// WORKING plaintext credential, and FAILS CLOSED on a tampered/orphaned token
	// rather than deploying ciphertext as a live credential.
	let runtimeVars: Array<[string, string]>;
	try {
		runtimeVars = selectRuntimeEnvVars(env);
	} catch (e) {
		reporter.step(SetupStep.EnvSet, 'Setting function-runtime env var(s)');
		reporter.fail((e as Error).message);
		return 1;
	}
	reporter.step(SetupStep.EnvSet, `Setting ${runtimeVars.length} function-runtime env var(s)`);
	s.start(`Setting ${runtimeVars.length} Convex function-runtime env var(s)`);
	try {
		await setConvexEnvVars(owlatDir, runtimeVars, (line) => reporter.log(line));
		s.stop(pc.green('Function-runtime env vars set'));
		reporter.ok();
		await checkpoint.complete('runtime-env');
	} catch (e) {
		s.stop(pc.red(`${(e as Error).message}`));
		reporter.fail((e as Error).message);
		return 1;
	}

	return 0;
}
