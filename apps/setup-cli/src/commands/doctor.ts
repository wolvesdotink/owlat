/* eslint-disable no-console */
/**
 * `owlat-setup doctor` — diagnose a broken install.
 *
 * Checks (in order):
 *   1. /opt/owlat/.env exists and parses.
 *   2. Required env vars for the active feature set are populated.
 *   3. SEND PATH: a sending feature is enabled AND a delivery provider
 *      (EMAIL_PROVIDER + its credentials) is actually configured — so doctor
 *      never green-lights an install that cannot send any mail.
 *   4. docker-compose.override.yml exists and matches the stored flags.
 *   5. Containers are running (best-effort: `docker compose ps` parse).
 *
 * Reports findings as a checklist; non-zero exit on any failure.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import pc from 'picocolors';
import {
	getRequiredEnvVars,
	getSendPathRequiredEnv,
	isDeliveryProviderKind,
	needsDeliveryProvider,
	resolveFlags,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import { readEnv, type EnvMap } from '../lib/env';

interface DoctorOptions {
	owlatDir: string;
	positional: string[];
}

export interface SendPathFinding {
	ok: boolean;
	message: string;
}

export interface MtaHealthFinding {
	ok: boolean;
	message: string;
}

/**
 * Pure send-path requirements check (no IO). Given the resolved flag posture and
 * the deployment env, decide whether a working delivery provider is present.
 *
 * Returns one finding per requirement, or `[]` when no sending feature is active
 * (nothing to verify). A non-`ok` finding means doctor must FAIL: a sending
 * feature is enabled but the install cannot deliver mail. Extracted from
 * `runDoctor` so the decision is unit-testable without the Bun runtime.
 */
export function evaluateSendPath(flags: FeatureFlagState, env: EnvMap): SendPathFinding[] {
	if (!needsDeliveryProvider(flags)) return [];

	const provider = env['EMAIL_PROVIDER'];
	if (!isDeliveryProviderKind(provider)) {
		return [
			{
				ok: false,
				message: provider
					? `a sending feature is enabled but EMAIL_PROVIDER="${provider}" is not a delivery provider (mta|resend|ses|smtp)`
					: 'a sending feature is enabled but EMAIL_PROVIDER is unset — set mta|resend|ses|smtp and its credentials, or this install cannot send mail',
			},
		];
	}

	return getSendPathRequiredEnv(provider).map((key) => ({
		ok: Boolean(env[key]),
		message: `${key} is set (required to send via ${provider})`,
	}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Pure interpretation of the MTA health body, separated for unit tests. */
export function evaluateMtaHealth(value: unknown): MtaHealthFinding[] {
	if (!isRecord(value)) return [{ ok: false, message: 'MTA returned an invalid health response' }];
	const worker = isRecord(value['worker']) ? value['worker'] : null;
	const emergency = isRecord(value['emergency']) ? value['emergency'] : null;
	const smtp = isRecord(value['smtpOutbound']) ? value['smtpOutbound'] : null;
	if (!worker || !emergency || !smtp || !Array.isArray(smtp['ips'])) {
		return [{ ok: false, message: 'MTA returned an incomplete health response' }];
	}

	const findings: MtaHealthFinding[] = [
		{ ok: value['redis'] === 'connected', message: 'MTA queue store is connected' },
		{ ok: worker['alive'] === true, message: 'MTA delivery worker is alive' },
		{ ok: value['dns'] === 'ok', message: 'MTA DNS resolver is reachable' },
		{
			ok: emergency['allIpsBlocked'] === false,
			message: 'MTA emergency circuit breaker is clear',
		},
	];

	if (smtp['ips'].length === 0) {
		findings.push({ ok: false, message: 'MTA has no sending IPs to probe' });
	}
	for (const item of smtp['ips']) {
		if (!isRecord(item) || typeof item['ip'] !== 'string') {
			findings.push({ ok: false, message: 'MTA returned an invalid sending-IP result' });
			continue;
		}
		const detail =
			typeof item['reason'] === 'string' ? ` (${item['reason'].replaceAll('_', ' ')})` : '';
		findings.push({
			ok: item['status'] === 'ok',
			message: `TCP/25 is reachable from ${item['ip']}${detail}`,
		});
	}
	return findings;
}

/** Single-shot probe of the MTA `/health` endpoint. */
async function probeMtaHealth(baseUrl: string): Promise<MtaHealthFinding[]> {
	const url = `${baseUrl.replace(/\/+$/, '')}/health`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 3000);
	try {
		const resp = await fetch(url, { signal: ctrl.signal });
		if (!resp.ok) return [{ ok: false, message: `${url} returned HTTP ${resp.status}` }];
		return evaluateMtaHealth(await resp.json());
	} catch (err) {
		return [{ ok: false, message: `${url} is unreachable (${(err as Error).message})` }];
	} finally {
		clearTimeout(timer);
	}
}

export async function runDoctor(opts: DoctorOptions): Promise<number> {
	let failures = 0;
	const check = (ok: boolean, msg: string) => {
		console.log(`${ok ? pc.green('✓') : pc.red('✗')} ${msg}`);
		if (!ok) failures++;
	};

	const envPath = join(opts.owlatDir, '.env');
	check(existsSync(envPath), `.env file present at ${envPath}`);
	const env = existsSync(envPath) ? await readEnv(envPath) : {};

	// Read flags from the local mirror.
	const statePath = join(opts.owlatDir, '.owlat-flags.json');
	let flags: FeatureFlagState = {};
	if (existsSync(statePath)) {
		try {
			flags = JSON.parse(await Bun.file(statePath).text()) as FeatureFlagState;
		} catch {
			check(false, 'Feature flags state file is unreadable');
		}
	}
	const resolved = resolveFlags(flags);

	const required = getRequiredEnvVars(flags);
	for (const key of required) {
		check(!!env[key], `${key} is set (required by an active feature)`);
	}

	// SEND PATH — the core capability check. A sending feature with no configured
	// delivery provider is the exact hole that let doctor report "All checks
	// passed" on an install that cannot send a single mail. FAIL (never warn).
	for (const finding of evaluateSendPath(flags, env)) {
		check(finding.ok, `SEND PATH: ${finding.message}`);
	}
	// A configured direct-delivery MTA that cannot reach recipient MX servers is
	// not ready to send. Treat every infrastructure finding as a real doctor
	// failure, including the source-IP-bound TCP/25 checks.
	if (needsDeliveryProvider(flags) && env['EMAIL_PROVIDER'] === 'mta' && env['MTA_API_URL']) {
		for (const finding of await probeMtaHealth(env['MTA_API_URL'])) {
			check(finding.ok, `SEND PATH: ${finding.message}`);
		}
	}

	const overridePath = join(opts.owlatDir, 'docker-compose.override.yml');
	check(existsSync(overridePath), `Compose override present at ${overridePath}`);

	// Best-effort docker check via shelling out.
	try {
		const proc = Bun.spawn(['docker', 'compose', 'ps', '--format', 'json'], {
			cwd: opts.owlatDir,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const output = await new Response(proc.stdout).text();
		const lines = output.trim().split('\n').filter(Boolean);
		const running = lines.length;
		check(running > 0, `${running} compose service(s) running`);
	} catch {
		check(false, 'docker compose not callable from this shell');
	}

	console.log();
	if (failures === 0) {
		console.log(
			pc.green(
				`All checks passed. Active features: ${Object.entries(resolved)
					.filter(([, v]) => v)
					.map(([k]) => k)
					.join(', ')}`
			)
		);
	} else {
		console.log(pc.red(`${failures} check(s) failed. Run \`owlat-setup config\` to fix.`));
	}
	return failures === 0 ? 0 : 1;
}
