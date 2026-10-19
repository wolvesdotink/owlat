/**
 * The evaluators and MTA probes behind `owlat-setup doctor`. The command itself
 * (the order the checks run in, and the text and `--json` output) lives in
 * `doctorRun.ts`; each evaluator here returns {@link DoctorFinding}s carrying a
 * stable check id from `lib/doctorReport.ts`.
 */

import {
	DELIVERY_PROVIDER_KINDS,
	getSendPathRequiredEnv,
	isDeliveryProviderKind,
	needsDeliveryProvider,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import type { EnvMap } from '../lib/env';
import type { DoctorFinding } from '../lib/doctorReport';
import { doctorText, envValue, trusted, urlValue } from '../lib/doctorText';
import {
	fcrdnsReasonMessage,
	reverseDnsGuidance,
	type FcrdnsFailureReason,
} from '@owlat/shared/fcrdns';
import { installerProviderNote } from '@owlat/shared/ipAuditProviders';
import { isRecord } from '@owlat/shared';

export type SendPathFinding = DoctorFinding;

export type MtaHealthFinding = DoctorFinding;

/** Interpret the exact runtime FCrDNS verdict exposed by the MTA health API. */
export function evaluateMtaIdentityHealth(value: unknown): MtaHealthFinding[] {
	if (!isRecord(value) || !Array.isArray(value['ips'])) {
		return [
			{
				check: 'mta.identity',
				ok: false,
				message: doctorText`MTA returned no outbound-IP identity status`,
			},
		];
	}
	if (value['ips'].length === 0) {
		return [
			{ check: 'mta.identity', ok: false, message: doctorText`MTA has no configured outbound IPs` },
		];
	}
	const findings: MtaHealthFinding[] = [];
	for (const item of value['ips']) {
		if (!isRecord(item) || typeof item['ip'] !== 'string' || !isRecord(item['fcrdns'])) {
			findings.push({
				check: 'mta.identity',
				ok: false,
				message: doctorText`MTA returned an invalid outbound-IP identity result`,
			});
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
				check: 'mta.identity',
				subject: item['ip'],
				ok: true,
				message: doctorText`FCrDNS ready for ${item['ip']}: PTR ${ptrNames.join(', ') || '(none)'} matches EHLO ${ehlo}${trusted(warning)}${trusted(bypass)}`,
			});
			continue;
		}
		const reason =
			typeof identity['reason'] === 'string'
				? (identity['reason'] as FcrdnsFailureReason)
				: undefined;
		const guidance = reverseDnsGuidance(ptrNames);
		findings.push({
			check: 'mta.identity',
			subject: item['ip'],
			ok: false,
			message: doctorText`FCrDNS blocked for ${item['ip']}: ${trusted(fcrdnsReasonMessage(reason))} Set its PTR exactly to ${ehlo}. ${trusted(guidance.instruction)}`,
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
		// The list the operator is told to pick from is the list the guard above
		// accepts — `isDeliveryProviderKind` is `DELIVERY_PROVIDER_KINDS` membership,
		// and that is the send-provider catalog under another name. Spelled by hand
		// it drifts silently and only in the DIRECTION THAT HURTS: a kind added to
		// the catalog keeps passing the check while doctor tells the operator it is
		// not a delivery provider (`mandrill` was exactly that).
		const kinds = DELIVERY_PROVIDER_KINDS.join('|');
		return [
			{
				check: 'send_path.provider',
				ok: false,
				message: provider
					? doctorText`a sending feature is enabled but EMAIL_PROVIDER="${envValue('EMAIL_PROVIDER', provider)}" is not a delivery provider (${trusted(kinds)})`
					: doctorText`a sending feature is enabled but EMAIL_PROVIDER is unset — set ${trusted(kinds)} and its credentials, or this install cannot send mail`,
			},
		];
	}

	return getSendPathRequiredEnv(provider).map((key) => ({
		check: 'send_path.credential',
		subject: key,
		ok: Boolean(env[key]),
		message: doctorText`${trusted(key)} is set (required to send via ${trusted(provider)})`,
	}));
}

/**
 * The retry ladder's one unowned structure.
 *
 * A GroupMQ `:delayed` member whose job hash is gone can never be delivered and
 * is removed by nothing, so it accrues silently until Redis runs out of memory.
 * ADDITIVE-ONLY: an MTA that predates the probe reports no `queue` block, and
 * that must read as "nothing to say", never as a failure.
 */
export function evaluateMtaQueueHealth(value: unknown): MtaHealthFinding[] {
	if (!isRecord(value)) return [];
	const queue = isRecord(value['queue']) ? value['queue'] : null;
	if (!queue || typeof queue['status'] !== 'string') return [];
	if (queue['status'] !== 'orphaned') return [];
	const orphaned = typeof queue['orphaned'] === 'number' ? queue['orphaned'] : 0;
	const sampled = typeof queue['sampled'] === 'number' ? queue['sampled'] : 0;
	const overdue = typeof queue['overdue'] === 'number' ? queue['overdue'] : 0;
	return [
		{
			check: 'mta.queue_leak',
			ok: false,
			message: doctorText`MTA retry queue is leaking — ${orphaned} of ${sampled} sampled overdue jobs have no message left to send, out of ${overdue} overdue. These grow until Redis runs out of memory; capture \`owlat logs mta\` and report this.`,
		},
	];
}

/** Pure interpretation of the MTA health body, separated for unit tests. */
export function evaluateMtaHealth(value: unknown, env: EnvMap = {}): MtaHealthFinding[] {
	if (!isRecord(value)) {
		return [
			{
				check: 'mta.health',
				ok: false,
				message: doctorText`MTA returned an invalid health response`,
			},
		];
	}
	const worker = isRecord(value['worker']) ? value['worker'] : null;
	const emergency = isRecord(value['emergency']) ? value['emergency'] : null;
	const smtp = isRecord(value['smtpOutbound']) ? value['smtpOutbound'] : null;
	if (!worker || !emergency || !smtp || !Array.isArray(smtp['ips'])) {
		return [
			{
				check: 'mta.health',
				ok: false,
				message: doctorText`MTA returned an incomplete health response`,
			},
		];
	}

	const findings: MtaHealthFinding[] = [
		{
			check: 'mta.queue_store',
			ok: value['redis'] === 'connected',
			message: doctorText`MTA queue store is connected`,
		},
		{
			check: 'mta.worker',
			ok: worker['alive'] === true,
			message: doctorText`MTA delivery worker is alive`,
		},
		{
			check: 'mta.dns',
			ok: value['dns'] === 'ok',
			message: doctorText`MTA DNS resolver is reachable`,
		},
		{
			check: 'mta.circuit_breaker',
			ok: emergency['allIpsBlocked'] === false,
			message: doctorText`MTA emergency circuit breaker is clear`,
		},
	];
	findings.push(...evaluateMtaIdentityHealth(value));
	findings.push(...evaluateMtaQueueHealth(value));

	if (smtp['ips'].length === 0) {
		findings.push({
			check: 'mta.sending_ips',
			ok: false,
			message: doctorText`MTA has no sending IPs to probe`,
		});
	}
	// A blocked TCP/25 is nearly always the provider, not the install. The note
	// goes on the FIRST blocked address only — a nudge, not a lecture, however
	// many addresses are bound.
	let nudged = false;
	for (const item of smtp['ips']) {
		if (!isRecord(item) || typeof item['ip'] !== 'string') {
			findings.push({
				check: 'mta.sending_ips',
				ok: false,
				message: doctorText`MTA returned an invalid sending-IP result`,
			});
			continue;
		}
		// Not a port-25 result: the MTA skips the probe for addresses that NAT
		// sends from one egress address, and the fix is the network mode, not the
		// provider. Delivery continues, so this stays advisory copy on a failed row.
		if (item['reason'] === 'shared_nat_egress') {
			findings.push({
				check: 'mta.tcp25',
				subject: item['ip'],
				ok: false,
				message: doctorText`${item['ip']} shares one NAT egress address with other sending IPs, so it does not send from its own address (TCP/25 not probed) — run the MTA with host networking or macvlan, or send from one IP per install`,
			});
			continue;
		}
		const detail =
			typeof item['reason'] === 'string' ? ` (${item['reason'].replaceAll('_', ' ')})` : '';
		const ok = item['status'] === 'ok';
		const nudge =
			ok || nudged ? '' : ` — ${installerProviderNote(env['MTA_VPS_PROVIDER'] ?? '').note}`;
		if (nudge) nudged = true;
		findings.push({
			check: 'mta.tcp25',
			subject: item['ip'],
			ok,
			message: doctorText`TCP/25 is reachable from ${item['ip']}${detail}${trusted(nudge)}`,
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
			check: 'mta.ip_audit',
			subject: audit['ip'],
			ok: verdict !== 'unusable',
			message: doctorText`IP audit for ${audit['ip']}: ${headline}${nextAction}${links}${trusted(confidence)}`,
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

type MtaHealthBody = { ok: true; body: unknown } | { ok: false; finding: MtaHealthFinding };

/** GET `/health`; a failure comes back as the finding to report, never as a throw. */
async function fetchMtaHealth(baseUrl: string): Promise<MtaHealthBody> {
	const url = `${baseUrl.replace(/\/+$/, '')}/health`;
	// The configured URL may carry credentials; only its sanitized form is printed.
	const unreachable = (detail: string): MtaHealthBody => ({
		ok: false,
		finding: {
			check: 'mta.health',
			ok: false,
			message: doctorText`${urlValue(url)} is unreachable (${detail})`,
		},
	});
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 3000);
	try {
		const resp = await fetch(url, { signal: ctrl.signal });
		if (!resp.ok) return unreachable(`${urlValue(url)} returned HTTP ${resp.status}`);
		return { ok: true, body: await resp.json() };
	} catch (err) {
		return unreachable((err as Error).message);
	} finally {
		clearTimeout(timer);
	}
}

/** Single-shot full infrastructure probe of the MTA `/health` endpoint. */
export async function probeMtaHealth(
	baseUrl: string,
	env: EnvMap = {}
): Promise<MtaHealthFinding[]> {
	const health = await fetchMtaHealth(baseUrl);
	return health.ok ? evaluateMtaHealth(health.body, env) : [health.finding];
}

/**
 * Force a live re-observation of every sending identity, and read the result.
 *
 * `/health` answers with the verdict the MTA's last sweep STORED — at boot, then
 * hourly. That is the wrong source for the one question setup asks: the operator
 * has just fixed a PTR record and wants to know whether it took. Nothing would
 * re-observe it in time — `docker compose up -d` leaves an unchanged container
 * running, so there is not even a boot sweep — and the install would fail again
 * on DNS that is already correct. `POST /identity/recheck` re-resolves now.
 *
 * Returns null (rather than findings) when the endpoint is unavailable — no key,
 * an older MTA image without the route, a timeout — so the caller falls back to
 * `/health` and an install never fails because a re-check was not possible.
 */
export async function refreshMtaIdentity(
	baseUrl: string,
	apiKey: string | undefined
): Promise<MtaHealthFinding[] | null> {
	if (!apiKey) return null;
	const url = `${baseUrl.replace(/\/+$/, '')}/identity/recheck`;
	const ctrl = new AbortController();
	// DNS, not HTTP, sets the floor here: each identity may wait out a 5s
	// resolver budget, so allow more than the 3s the read-only probes use.
	const timer = setTimeout(() => ctrl.abort(), 30_000);
	try {
		const resp = await fetch(url, {
			method: 'POST',
			signal: ctrl.signal,
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!resp.ok) return null;
		return evaluateMtaIdentityHealth(await resp.json());
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Setup-time identity-only probe; worker traffic is not required yet. Prefers a
 * forced re-check so a PTR fixed minutes ago is seen, and falls back to the
 * stored `/health` verdict when that is not available.
 */
export async function probeMtaIdentityHealth(
	baseUrl: string,
	apiKey?: string
): Promise<MtaHealthFinding[]> {
	const refreshed = await refreshMtaIdentity(baseUrl, apiKey);
	if (refreshed) return refreshed;
	const health = await fetchMtaHealth(baseUrl);
	return health.ok ? evaluateMtaIdentityHealth(health.body) : [health.finding];
}
