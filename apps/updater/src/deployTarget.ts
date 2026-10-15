/**
 * The convex the staged deploy talks to, judged before `run convex-deploy`.
 *
 * `run` reconciles `depends_on` against the staged template, so a convex whose
 * config the release changes is recreated — a cold boot before the schema is
 * even validated, behind a "running stack untouched" if the deploy then fails.
 * A convex that exists is therefore deployed to as it is (`--no-deps`), once
 * it is serving; only one that does not exist is left to `depends_on` to start.
 */

import { parseComposePs } from '@owlat/shared/containerHealth';
import { exec, OWLAT_DIR } from './http.js';
import { judgeService, verifyReadiness } from './readiness.js';

export type DeployTarget =
	| { kind: 'serving' }
	| { kind: 'absent' }
	| { kind: 'unavailable'; detail: string };

export async function deployTarget(service: string, composeArgs: string[]): Promise<DeployTarget> {
	const listed = await exec(
		'docker',
		[...composeArgs, 'ps', '--format', 'json', service],
		OWLAT_DIR
	);
	if (!listed.ok) {
		return { kind: 'unavailable', detail: `its state could not be read (${listed.stderr.trim()})` };
	}
	const verdict = judgeService(service, parseComposePs(listed.stdout));
	if (verdict.standing === 'missing') return { kind: 'absent' };
	if (verdict.standing === 'ready') return { kind: 'serving' };
	if (verdict.standing === 'failing') return { kind: 'unavailable', detail: verdict.detail };
	// Still booting (a large database takes minutes): wait for it as it is.
	const readiness = await verifyReadiness([service], composeArgs);
	return readiness.ready ? { kind: 'serving' } : { kind: 'unavailable', detail: readiness.summary };
}
