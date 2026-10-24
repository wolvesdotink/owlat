/* eslint-disable no-console -- a CLI command reports to the terminal */
/**
 * `owlat-setup doctor [--json]` — diagnose a broken install.
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
 *   5b. CONTAINERS: no container is crash-looping or failing its healthcheck —
 *       being LISTED by `docker compose ps` is not the same as being up.
 *   5c. VERSION: every Owlat container actually runs the configured
 *       OWLAT_VERSION. Compose pins images to `${OWLAT_VERSION:-dev}`, so
 *       advancing `.env` without recreating the containers leaves the version
 *       the product REPORTS diverged from the one it RUNS.
 *
 * Reports findings as a checklist, or with `--json` as one redacted
 * {@link DoctorReport} document on stdout; non-zero exit on any failure in
 * either mode. Both outputs render the same recorded checks.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
	getRequiredEnvVars,
	needsDeliveryProvider,
	resolveFlags,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import { isOwnSendProviderKind } from '@owlat/shared/sendProviderCatalog';
import {
	evaluateContainerStates,
	evaluateVersionDrift,
	parseComposePs,
} from '@owlat/shared/containerHealth';
import { readEnv } from '../lib/env';
import {
	DoctorReportBuilder,
	renderDoctorCheckLine,
	renderDoctorSummary,
	type DoctorCheck,
	type DoctorReport,
} from '../lib/doctorReport';
import { doctorText, envValue, trusted } from '../lib/doctorText';
import { evaluateSendPath, probeIpAudit, probeMtaHealth, refreshMtaIdentity } from './doctor';

interface DoctorOptions {
	owlatDir: string;
	positional: string[];
	args?: string[];
}

/** The runtime edges of a doctor run, injectable so the whole run is testable. */
export interface DoctorIo {
	/** stdout of `docker compose ps --format json` in `cwd`; throws when it cannot run. */
	composePs(cwd: string): Promise<string>;
	now(): Date;
	print(line: string): void;
}

const BUN_DOCTOR_IO: DoctorIo = {
	async composePs(cwd) {
		const proc = Bun.spawn(['docker', 'compose', 'ps', '--format', 'json'], {
			cwd,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return await new Response(proc.stdout).text();
	},
	now: () => new Date(),
	print: (line) => console.log(line),
};

export interface CollectDoctorOptions {
	/**
	 * Ask the MTA to re-resolve reverse DNS before reading its health (default
	 * true). That is a write on the MTA's side, so a read-only collector such as
	 * the support bundle turns it off and reports the stored verdict.
	 */
	recheckIdentity?: boolean;
	/**
	 * Keep only the code-owned text of each message (default false). The support
	 * bundle sets it: runtime text such as an MTA headline or an IP-audit note
	 * can carry personal data that doctor's known-secret pass cannot recognise.
	 */
	codeOwnedMessages?: boolean;
}

/**
 * Run every check against the install in `owlatDir` and return the report.
 * `onCheck` sees each check as it is recorded, so the text checklist streams
 * while the slower MTA and docker probes are still running.
 */
export async function collectDoctorReport(
	owlatDir: string,
	io: DoctorIo,
	onCheck?: (check: DoctorCheck) => void,
	options: CollectDoctorOptions = {}
): Promise<DoctorReport> {
	const report = new DoctorReportBuilder(onCheck);
	if (options.codeOwnedMessages === true) report.withholdRuntimeText();

	const envPath = join(owlatDir, '.env');
	const envPresent = existsSync(envPath);
	const env = envPresent ? await readEnv(envPath) : {};
	report.useEnv(env);
	report.record({
		check: 'env.file',
		ok: envPresent,
		message: doctorText`.env file present at ${trusted(envPath)}`,
	});

	// Read flags from the local mirror.
	const statePath = join(owlatDir, '.owlat-flags.json');
	let flags: FeatureFlagState = {};
	if (existsSync(statePath)) {
		try {
			flags = JSON.parse(await readFile(statePath, 'utf-8')) as FeatureFlagState;
		} catch {
			report.record({
				check: 'flags.state',
				ok: false,
				message: doctorText`Feature flags state file is unreadable`,
			});
		}
	}
	const resolved = resolveFlags(flags);

	for (const key of getRequiredEnvVars(flags)) {
		report.record({
			check: 'env.required',
			subject: key,
			ok: !!env[key],
			message: doctorText`${trusted(key)} is set (required by an active feature)`,
		});
	}

	// SEND PATH — the core capability check. A sending feature with no configured
	// delivery provider is the exact hole that let doctor report "All checks
	// passed" on an install that cannot send a single mail. FAIL (never warn).
	for (const finding of evaluateSendPath(flags, env)) report.record(finding);
	// A configured direct-delivery MTA that cannot reach recipient MX servers is
	// not ready to send. Treat every infrastructure finding as a real doctor
	// failure, including the source-IP-bound TCP/25 checks.
	if (
		needsDeliveryProvider(flags) &&
		isOwnSendProviderKind(env['EMAIL_PROVIDER']) &&
		env['MTA_API_URL']
	) {
		// `owlat doctor` is what the docs tell an operator to run after changing
		// reverse DNS, so re-observe before reporting: the stored verdict can be up
		// to an hour old and would answer about the PTR they just replaced.
		if (options.recheckIdentity !== false) {
			await refreshMtaIdentity(env['MTA_API_URL'], env['MTA_API_KEY']);
		}
		for (const finding of await probeMtaHealth(env['MTA_API_URL'], env)) report.record(finding);
		// Pre-flight IP audit: the operator sees the verdict and the delisting path
		// BEFORE investing hours in DNS. Silent when no audit exists yet.
		for (const finding of await probeIpAudit(env['MTA_API_URL'], env['MTA_API_KEY'])) {
			report.record(finding);
		}
	}

	const overridePath = join(owlatDir, 'docker-compose.override.yml');
	report.record({
		check: 'compose.override',
		ok: existsSync(overridePath),
		message: doctorText`Compose override present at ${trusted(overridePath)}`,
	});

	// Best-effort docker check via shelling out.
	try {
		const services = parseComposePs(await io.composePs(owlatDir));
		report.record({
			check: 'compose.services',
			ok: services.length > 0,
			message: doctorText`${services.length} compose service(s) running`,
		});

		// Being LISTED is not being up. `docker compose ps` reports a container
		// that has been crash-looping for hours exactly like a healthy one, so
		// counting services green-lit an install with a dead service in it.
		// `doctorText` as the format keeps the evaluators' copy code-owned; only
		// docker's values (service, state, status line) are runtime parts.
		for (const finding of evaluateContainerStates(services, doctorText)) {
			report.record({ check: 'containers.health', subject: finding.service, ...finding });
		}

		// VERSION DRIFT — the configured version (.env, which every version
		// surface in the product reports) against the tag each container was
		// actually created from. Advancing .env without recreating the
		// containers leaves the product claiming a version it is not running.
		const configuredVersion = envValue('OWLAT_VERSION', env['OWLAT_VERSION'] ?? '');
		for (const finding of evaluateVersionDrift(services, configuredVersion, doctorText)) {
			report.record({ check: 'version.drift', subject: finding.service, ...finding });
		}
	} catch {
		report.record({
			check: 'compose.cli',
			ok: false,
			message: doctorText`docker compose not callable from this shell`,
		});
	}

	const activeFeatures = Object.entries(resolved)
		.filter(([, enabled]) => enabled)
		.map(([key]) => key);
	return report.build(activeFeatures, io.now());
}

export async function runDoctor(
	opts: DoctorOptions,
	io: DoctorIo = BUN_DOCTOR_IO
): Promise<number> {
	const json = opts.args?.includes('--json') === true;
	const report = await collectDoctorReport(
		opts.owlatDir,
		io,
		json ? undefined : (check) => io.print(renderDoctorCheckLine(check))
	);
	if (json) {
		io.print(JSON.stringify(report, null, 2));
	} else {
		io.print('');
		io.print(renderDoctorSummary(report));
	}
	return report.ok ? 0 : 1;
}
