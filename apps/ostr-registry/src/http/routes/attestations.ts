/**
 * `POST /v1/attestations` — the submission endpoint (plan §8.2, §9.1).
 *
 * Open and unauthenticated by design: an attestation carries an ed25519
 * signature over its own canonical form and names the observer whose key is
 * published at `_ostr.<observer>`, so the record authenticates itself and an
 * API key would only add a gatekeeper the design exists to remove. What the
 * endpoint does NOT do is judge the claim: acceptance means well-formed and
 * correctly signed, never true.
 *
 * Accepted submissions answer `201` with the log index, whether the entry was
 * already present, and the signed inclusion promise (the SCT-equivalent of
 * RFC 9162 §3.1: a commitment to merge the entry within the log's MMD).
 * Rejected ones answer `422` with every reason at once — a submitter that got
 * one message per round-trip would fix one field per round-trip.
 */
import type { Hono } from 'hono';
import type { RegistryLog } from '../../contracts.js';
import { readJsonBody } from '../body.js';

export interface AttestationRouteDeps {
	log: RegistryLog;
	/** The log's clock: an RFC 3339 UTC instant for `receivedAt`. */
	now: () => string;
	maxBodyBytes: number;
}

export function registerAttestationRoutes(app: Hono, deps: AttestationRouteDeps): void {
	app.post('/v1/attestations', async (c) => {
		const candidate = await readJsonBody(c.req.raw, deps.maxBodyBytes);
		const outcome = await deps.log.submit(candidate, deps.now());
		if (!outcome.accepted) {
			return c.json({ errors: outcome.errors }, 422);
		}
		return c.json(
			{ index: outcome.index, duplicate: outcome.duplicate, promise: outcome.promise },
			201
		);
	});
}
