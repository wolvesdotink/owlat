/**
 * THE SIGNAL-SOURCE REGISTRY (seams plan D9) — one inventory of where this
 * deployment's deliverability evidence comes from.
 *
 * WHAT THE REGISTRY IS FOR. Not dispatch: the ramp's own measurements are
 * iterated through the typed, ORDERED `RAMP_GATE_SIGNAL_SOURCES` list that gate
 * evaluation imports, and each provider feed is consumed by the one reader that
 * has its input shape. What lives here is the QUESTION NOBODY COULD ASK BEFORE —
 * which sources exist, what class each belongs to, and what each does when it is
 * not configured — answered exhaustively and by type, so a source added later
 * cannot be added quietly.
 *
 * EXHAUSTIVE BY TYPE. The record is keyed by `SignalSourceKey`, so a new key in
 * the vocabulary is a compile error here until it is registered, and a
 * registered source that names a key nobody declared does not compile either.
 *
 * WHAT IS DELIBERATELY NOT HERE. The shipped relay-fallback triggers
 * (`ip_quarantined`, `dnsbl_listed`, `dnsbl_partial`, `dnsbl_unknown`) are
 * declared in the shared routing vocabulary and recorded by the routing plane;
 * nothing collects them through this contract, and registering a source with no
 * collector would be an inventory row that promises a reader there is not.
 *
 * NO PLUGIN BUCKET (deliberate). Third-party signal sources are deferred: the
 * registry is the seam, and opening it is a one-piece follow-up on the day
 * someone wants it. Nothing here reads a manifest or a contribution.
 */

import { GOOGLE_POSTMASTER_SIGNAL_SOURCE } from './postmaster';
import { RAMP_GATE_SIGNALS } from './rampGateSources';
import { SNDS_SIGNAL_SOURCE } from './snds';
import type { SignalSourceDeclaration, SignalSourceKey } from './types';
import { YAHOO_CFL_SIGNAL_SOURCE } from './yahooCfl';

/**
 * Every declared signal source, keyed by its name in the vocabulary.
 *
 * The ramp's five are SPREAD from the record gate evaluation folds rather than
 * listed again: the inventory and the fold are then the same five objects, so
 * "registered" and "measured" cannot come apart the way two lists would let
 * them. The three provider feeds have no fold to spread from — each is consumed
 * by the one reader that has its input shape — so they are named here.
 */
export const SIGNAL_SOURCES: Readonly<Record<SignalSourceKey, SignalSourceDeclaration>> = {
	...RAMP_GATE_SIGNALS,
	snds: SNDS_SIGNAL_SOURCE,
	yahoo_cfl: YAHOO_CFL_SIGNAL_SOURCE,
	google_postmaster: GOOGLE_POSTMASTER_SIGNAL_SOURCE,
};

/** Every declared source, in registration order. */
export function allSignalSources(): readonly SignalSourceDeclaration[] {
	return Object.values(SIGNAL_SOURCES);
}
