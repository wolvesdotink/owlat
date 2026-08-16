/**
 * POST /apply-profiles — apply a resolved feature-flag snapshot to the running
 * stack (plan D3/G2: the updater is the SINGLE writer converging `.env`'s
 * COMPOSE_PROFILES, the compose override and the CLI flag mirror). The body
 * carries flags, never profiles — profiles are derived server-side via the
 * shared registry, so the web app can only request states the registry can
 * produce.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getActiveProfiles } from '@owlat/shared/featureFlags';
import {
	parseDeliveryProviderFromEnv,
	renderComposeOverrideYaml,
} from '@owlat/shared/composeOverride';
import { applyEnvUpdates, errorMessage, isRateLimited, validateFlagSnapshot } from './security.js';
import { composePsServices, exec, json, OWLAT_DIR, readBody, requireAuth } from './http.js';

export async function handleApplyProfiles(req: IncomingMessage, res: ServerResponse) {
	if (!requireAuth(req, res)) return;

	// Rate limit: `compose up -d` can take a minute — match /update's budget.
	if (isRateLimited('apply-profiles', 2, 60_000)) {
		return json(res, 429, { error: 'Too many apply-profiles requests. Try again later.' });
	}

	let snapshot: ReturnType<typeof validateFlagSnapshot>;
	try {
		const body = JSON.parse(await readBody(req)) as { flags?: unknown };
		snapshot = validateFlagSnapshot(body.flags);
	} catch {
		return json(res, 400, { error: 'Invalid JSON body' });
	}
	if (!snapshot.ok) {
		return json(res, 400, { error: snapshot.reason });
	}
	const flags = snapshot.flags;

	const envFile = join(OWLAT_DIR, '.env');
	let envContent: string;
	try {
		envContent = readFileSync(envFile, 'utf-8');
	} catch (err) {
		return json(res, 500, { error: `Cannot read .env: ${errorMessage(err)}` });
	}

	// The built-in MTA also activates when it is the delivery provider — an
	// env-driven rule, so read EMAIL_PROVIDER from the co-located .env exactly
	// like the setup CLI's override writer does.
	const deliveryProvider = parseDeliveryProviderFromEnv(envContent);
	const profiles = getActiveProfiles(flags, { deliveryProvider });

	const steps: { step: string; ok?: boolean; stdout: string; stderr: string }[] = [];

	// Step 1: converge COMPOSE_PROFILES in .env (append when a pre-profiles
	// install lacks the line). Single-key allowlist — never the rotation keys.
	const rewrite = applyEnvUpdates(
		envContent,
		{ COMPOSE_PROFILES: profiles.join(',') },
		['COMPOSE_PROFILES'],
		{ appendMissing: true }
	);
	if (!rewrite.ok) {
		return json(res, 500, { error: rewrite.reason });
	}
	try {
		writeFileSync(envFile, rewrite.content, 'utf-8');
		steps.push({ step: 'write-env', stdout: `COMPOSE_PROFILES=${profiles.join(',')}`, stderr: '' });
	} catch (err) {
		return json(res, 500, { error: `Cannot write .env: ${errorMessage(err)}`, steps });
	}

	// Step 2: regenerate the override via the shared writer.
	try {
		writeFileSync(
			join(OWLAT_DIR, 'docker-compose.override.yml'),
			renderComposeOverrideYaml(profiles),
			'utf-8'
		);
		steps.push({
			step: 'write-override',
			stdout: `Active profiles: ${profiles.join(', ') || '(none)'}`,
			stderr: '',
		});
	} catch (err) {
		return json(res, 500, { error: `Cannot write compose override: ${errorMessage(err)}`, steps });
	}

	// Step 3: mirror the snapshot to the CLI-side flag store so `owlat doctor` /
	// `feature` / `pack` see the applied state instead of recomputing defaults.
	try {
		writeFileSync(join(OWLAT_DIR, '.owlat-flags.json'), JSON.stringify(flags, null, 2), {
			mode: 0o600,
		});
		steps.push({ step: 'write-flag-mirror', stdout: 'Wrote .owlat-flags.json', stderr: '' });
	} catch (err) {
		return json(res, 500, { error: `Cannot write flag mirror: ${errorMessage(err)}`, steps });
	}

	// Step 4: apply — compose reads COMPOSE_PROFILES from the .env just written.
	const up = exec('docker compose up -d --remove-orphans', OWLAT_DIR);
	steps.push({ step: 'up', ...up });
	if (!up.ok) {
		return json(res, 500, { error: 'docker compose up failed', profiles, steps });
	}

	// Report per-service state so the caller can render health for each service.
	const { containers, raw } = composePsServices();
	json(res, 200, {
		success: true,
		profiles,
		steps,
		services: containers.length > 0 ? containers : raw,
	});
}
