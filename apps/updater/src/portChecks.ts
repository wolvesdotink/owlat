/**
 * POST /port-checks — probe the ports this instance depends on and report which
 * of them are open, from the one component that can actually find out.
 *
 * The updater is the only service with both the host `.env` (which says what
 * this instance is configured to do) and ordinary egress, so it can answer
 * "is 993 open?" — a question the Convex function runtime cannot ask and the
 * browser certainly cannot.
 *
 * POST, not GET: each call opens connections to third parties. That must be an
 * operator pressing a button, never a page prefetching.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	parseComposeProfilesFromEnv,
	parseDeliveryProviderFromEnv,
} from '@owlat/shared/composeOverride';
import {
	selectPortChecks,
	summarizePortChecks,
	type PortCheckStatus,
	type SelectedPortCheck,
} from '@owlat/shared/networkPorts';
import { errorMessage } from '@owlat/shared';
import { isRateLimited } from './security.js';
import { json, OWLAT_DIR, requireAuth } from './http.js';
import { isNameResolutionCode, probeDns, probeTcp, type ProbeResult } from './portProbe.js';

interface PortCheckReport extends SelectedPortCheck {
	status: PortCheckStatus;
	durationMs: number;
}

async function runCheck(check: SelectedPortCheck): Promise<PortCheckReport> {
	const result: ProbeResult =
		check.probe === 'dns'
			? await probeDns({ domain: check.target })
			: await probeTcp({ host: check.target, port: check.port });

	// An inbound probe dials a compose SERVICE name. When the feature is off the
	// container does not exist, so the name does not resolve — that is "this
	// instance does not run that service", not a broken port, and saying
	// `skipped` keeps it out of the blocked-port count. It still counts as
	// unmeasured, which is what keeps a REQUIRED service that is missing from
	// reading as an all-clear.
	const status: PortCheckStatus =
		check.direction === 'inbound' && isNameResolutionCode(result.code) ? 'skipped' : result.status;

	return { ...check, status, durationMs: result.durationMs };
}

export async function handlePortChecks(req: IncomingMessage, res: ServerResponse) {
	if (!requireAuth(req, res)) return;

	// Each call is up to ten outbound connections; twice a minute is plenty for
	// a human pressing "Re-check" and low enough that nobody can aim the
	// instance at a third party.
	if (isRateLimited('port-checks', 2, 60_000)) {
		return json(res, 429, { error: 'Too many port-check requests. Try again in a minute.' });
	}

	let envContent: string;
	try {
		envContent = readFileSync(join(OWLAT_DIR, '.env'), 'utf-8');
	} catch (err) {
		return json(res, 500, { error: `Cannot read .env: ${errorMessage(err)}` });
	}

	const checks = selectPortChecks({
		profiles: parseComposeProfilesFromEnv(envContent),
		deliveryProvider: parseDeliveryProviderFromEnv(envContent),
	});

	// In parallel: they are independent, and serially they would add up to
	// fifty seconds of dead air on a firewalled host.
	const reports = await Promise.all(checks.map(runCheck));

	json(res, 200, {
		checkedAt: Date.now(),
		verdict: summarizePortChecks(reports),
		checks: reports,
	});
}
