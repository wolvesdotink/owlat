/**
 * Which non-MTA transports this deployment actually has configured — the ONE
 * answer, read by everything that needs to know whether a second arm exists.
 *
 * It lives on its own because two unrelated readers need it: the alignment
 * pre-flight (which arm is the reference?) and the return-path capability read
 * (which transport is the wizard's step 4 actually probing?). A second copy in
 * either place is how the two would come to disagree about the same
 * configuration.
 *
 * D2: "no relay at all" is a first-class answer here, never an error.
 */

import type { QueryCtx } from '../_generated/server';
import { getOptional } from '../lib/env';

/** Upper bound on the (per-messageType) route rows we inspect for a relay. */
const PROVIDER_ROUTE_SCAN_LIMIT = 16;

/**
 * Every configured non-MTA transport kind, from the SHIPPED surfaces: each
 * enabled `providerRoutes` entry plus the single-transport `EMAIL_PROVIDER` env.
 * The shipped transport set is wider than SES (`mta`/`ses`/`resend`/`smtp` plus
 * `plugin.*`), so answering this from the SES identity table alone would report
 * "single arm" for a Resend/SMTP/plugin relay and let two genuinely unaligned
 * arms ramp.
 */
export async function configuredRelayKinds(ctx: QueryCtx): Promise<string[]> {
	// One row per messageType — tiny by construction, and bounded anyway.
	const routes = await ctx.db.query('providerRoutes').take(PROVIDER_ROUTE_SCAN_LIMIT);
	const kinds = new Set<string>();
	for (const route of routes) {
		for (const provider of route.providers) {
			if (provider.isEnabled && provider.providerType !== 'mta') kinds.add(provider.providerType);
		}
	}
	const envProvider = getOptional('EMAIL_PROVIDER')?.trim();
	if (envProvider !== undefined && envProvider !== '' && envProvider !== 'mta') {
		kinds.add(envProvider);
	}
	return [...kinds].sort();
}

/**
 * The REFERENCE transport id — the second arm — or null when there is not
 * exactly one.
 *
 * Deliberately not "the active transport": on a standalone deployment the
 * active transport is the own MTA, and answering the reference question with it
 * would describe our own infrastructure under copy that says "this provider".
 * Zero relays is the standalone configuration (null, and the caller says so
 * plainly); more than one means there is no single second arm to describe, which
 * is the same answer the alignment pre-flight gives that configuration.
 *
 * A kind maps onto its DEFAULT transport id, which is the kind itself
 * (`defaultSendTransportId`); an id this deployment cannot resolve is the
 * caller's problem to render, and every caller resolves it to a degraded
 * posture rather than an error (D2).
 */
export async function referenceRelayTransportId(ctx: QueryCtx): Promise<string | null> {
	const kinds = await configuredRelayKinds(ctx);
	return kinds.length === 1 ? (kinds[0] ?? null) : null;
}
