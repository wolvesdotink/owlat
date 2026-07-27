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
 *   3b. SEND PATH: the pre-flight IP audit verdict for each sending address,
 *       with its next action and any delisting URL — advisory, and silent when
 *       no audit has been recorded.
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
import {
	fcrdnsReasonMessage,
	reverseDnsGuidance,
	type FcrdnsFailureReason,
} from '@owlat/shared/fcrdns';
import { installerProviderNote } from '@owlat/shared/ipAuditProviders';

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

/** Interpret the exact runtime FCrDNS verdict exposed by the MTA health API. */
export function evaluateMtaIdentityHealth(value: unknown): MtaHealthFinding[] {
	if (!isRecord(value) || !Array.isArray(value['ips'])) {
		return [{ ok: false, message: 'MTA returned no outbound-IP identity status' }];
	}
	if (value['ips'].length === 0) {
		return [{ ok: false, message: 'MTA has no configured outbound IPs' }];
	}
	const findings: MtaHealthFinding[] = [];
	for (const item of value['ips']) {
		if (!isRecord(item) || typeof item['ip'] !== 'string' || !isRecord(item['fcrdns'])) {
			findings.push({ ok: false, message: 'MTA returned an invalid outbound-IP identity result' });
			continue;
		}
		const identity = item['fcrdns'];
		const ehlo = typeof identity['ehlo'] === 'string' ? identity['ehlo'] : '(missing EHLO)';
		const ptrNames = Array.isArray(identity['ptrNames'])
			? identity['ptrNames'].filter((name): name is string => typeof name === 'string')
			: [];
		const overridden = identity['overridden'] === true;
		const ready = identity['verdict'] === 'pass' || identity['verdict'] === 'warn' || overridden;
		if (ready) {
			const warning = identity['verdict'] === 'warn' ? ' (generic PTR — reputationally poor)' : '';
			const bypass = overridden ? ' (lab override enabled)' : '';
			findings.push({
				ok: true,
				message: `FCrDNS ready for ${item['ip']}: PTR ${ptrNames.join(', ') || '(none)'} matches EHLO ${ehlo}${warning}${bypass}`,
			});
			continue;
		}
		const reason =
			typeof identity['reason'] === 'string'
				? (identity['reason'] as FcrdnsFailureReason)
				: undefined;
		const guidance = reverseDnsGuidance(ptrNames);
		findings.push({
			ok: false,
			message:
				`FCrDNS blocked for ${item['ip']}: ${fcrdnsReasonMessage(reason)} ` +
				`Set its PTR exactly to ${ehlo}. ${guidance.instruction}`,
		});
	}
	return findings;
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
export function evaluateMtaHealth(value: unknown, env: EnvMap = {}): MtaHealthFinding[] {
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
	findings.push(...evaluateMtaIdentityHealth(value));

	if (smtp['ips'].length === 0) {
		findings.push({ ok: false, message: 'MTA has no sending IPs to probe' });
	}
	// A blocked TCP/25 is nearly always the provider, not the install. The note
	// goes on the FIRST blocked address only — a nudge, not a lecture, however
	// many addresses are bound.
	let nudged = false;
	for (const item of smtp['ips']) {
		if (!isRecord(item) || typeof item['ip'] !== 'string') {
			findings.push({ ok: false, message: 'MTA returned an invalid sending-IP result' });
			continue;
		}
		const detail =
			typeof item['reason'] === 'string' ? ` (${item['reason'].replaceAll('_', ' ')})` : '';
		const ok = item['status'] === 'ok';
		const nudge =
			ok || nudged ? '' : ` — ${installerProviderNote(env['MTA_VPS_PROVIDER'] ?? '').note}`;
		if (nudge) nudged = true;
		findings.push({
			ok,
			message: `TCP/25 is reachable from ${item['ip']}${detail}${nudge}`,
		});
	}
	return findings;
}

/**
 * Render the pre-flight IP audit for the installer.
 *
 * This is the operator-facing surface of the audit: three plainly-worded
 * verdicts, each with its next action, and — when the address is listed — the
 * zone-specific removal URL. Only `unusable` fails doctor; `action_required`
 * tells the operator exactly what to fix before investing hours in DNS.
 *
 * ADDITIVE-ONLY: no record, no endpoint, or a payload we cannot read prints
 * NOTHING. The audit is advisory, so its absence is a supported configuration
 * and can never be an error or a "setup incomplete" nag.
 */
export function evaluateIpAuditReport(value: unknown): MtaHealthFinding[] {
	if (!isRecord(value) || !Array.isArray(value['audits'])) return [];
	const findings: MtaHealthFinding[] = [];
	for (const audit of value['audits']) {
		if (!isRecord(audit) || typeof audit['ip'] !== 'string') continue;
		const verdict = audit['verdict'];
		if (verdict !== 'clean' && verdict !== 'action_required' && verdict !== 'unusable') continue;
		const headline = typeof audit['headline'] === 'string' ? audit['headline'] : '';
		const nextAction = typeof audit['nextAction'] === 'string' ? ` ${audit['nextAction']}` : '';
		const removals = Array.isArray(audit['delisting'])
			? audit['delisting']
					.filter(isRecord)
					.filter(
						(entry) => typeof entry['label'] === 'string' && typeof entry['removalUrl'] === 'string'
					)
					.map((entry) => `${String(entry['label'])}: ${String(entry['removalUrl'])}`)
			: [];
		const links = removals.length > 0 ? ` Delisting — ${removals.join('; ')}.` : '';
		const confidence =
			audit['confidence'] === 'low' ? ' (measurement confidence: low — re-run to confirm)' : '';
		findings.push({
			ok: verdict !== 'unusable',
			message: `IP audit for ${audit['ip']}: ${headline}${nextAction}${links}${confidence}`,
		});
	}
	return findings;
}

/**
 * Read the stored audit from the MTA. Every failure path — unreachable, 401,
 * 404, unparseable — yields no findings rather than a doctor failure.
 */
export async function probeIpAudit(baseUrl: string, apiKey?: string): Promise<MtaHealthFinding[]> {
	const url = `${baseUrl.replace(/\/+$/, '')}/ip-audit`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 3000);
	try {
		const resp = await fetch(url, {
			signal: ctrl.signal,
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		});
		if (!resp.ok) return [];
		return evaluateIpAuditReport(await resp.json());
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

async function fetchMtaHealth(baseUrl: string): Promise<unknown> {
	const url = `${baseUrl.replace(/\/+$/, '')}/health`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 3000);
	try {
		const resp = await fetch(url, { signal: ctrl.signal });
		if (!resp.ok) throw new Error(`${url} returned HTTP ${resp.status}`);
		return await resp.json();
	} catch (err) {
		throw new Error(`${url} is unreachable (${(err as Error).message})`);
	} finally {
		clearTimeout(timer);
	}
}

/** Single-shot full infrastructure probe of the MTA `/health` endpoint. */
export async function probeMtaHealth(
	baseUrl: string,
	env: EnvMap = {}
): Promise<MtaHealthFinding[]> {
	try {
		return evaluateMtaHealth(await fetchMtaHealth(baseUrl), env);
	} catch (err) {
		return [{ ok: false, message: (err as Error).message }];
	}
}

/** Setup-time identity-only probe; worker traffic is not required yet. */
export async function probeMtaIdentityHealth(baseUrl: string): Promise<MtaHealthFinding[]> {
	try {
		return evaluateMtaIdentityHealth(await fetchMtaHealth(baseUrl));
	} catch (err) {
		return [{ ok: false, message: (err as Error).message }];
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
		for (const finding of await probeMtaHealth(env['MTA_API_URL'], env)) {
			check(finding.ok, `SEND PATH: ${finding.message}`);
		}
		// Pre-flight IP audit: the operator sees the verdict and the delisting path
		// BEFORE investing hours in DNS. Silent when no audit exists yet.
		for (const finding of await probeIpAudit(env['MTA_API_URL'], env['MTA_API_KEY'])) {
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
