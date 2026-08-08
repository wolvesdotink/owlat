/**
 * THE SIGNAL-SOURCE REGISTRY (seams plan D9) — one inventory of where this
 * deployment's deliverability evidence comes from.
 *
 * WHAT THE REGISTRY IS FOR. Not dispatch: the ramp's own measurements are
 * iterated through the typed, ORDERED `RAMP_GATE_SIGNAL_SOURCES` list that gate
 * evaluation imports, and a provider feed is read through the source that has
 * its input shape — where anything reads it at all, which today is one of the
 * three (see below). What lives here is the QUESTION NOBODY COULD ASK BEFORE —
 * which sources exist, what class each belongs to, and what each does when it is
 * not configured — answered exhaustively and by type, so a source added later
 * cannot be added quietly.
 *
 * EXHAUSTIVE BY TYPE. The record is keyed by `SignalSourceKey`, so a new key in
 * the vocabulary is a compile error here until it is registered, and a
 * registered source that names a key nobody declared does not compile either.
 *
 * WHO READS WHAT, TODAY. An inventory is not a claim that everything in it is
 * wired: `google_postmaster` is the one feed read through `collect()` in
 * production (`../postmaster.ts`'s `getPostmasterStatus`); `snds` and
 * `yahoo_cfl` are declared, tested and unconsumed through this contract —
 * `evaluateSndsGate` is a complete verdict no decision path folds (see
 * `./snds.ts`), and the Yahoo stand-in is read directly, as
 * `yahooComplaintSubstitution`, by `../../domains/yahooCfl.ts`. Wiring either
 * into a decision path would change what the ramp does and is its own piece.
 * That is also what their `kind: 'advisory'` says out loud.
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
 * them. The three provider feeds have no fold to spread from — each carries its
 * own input shape and is read (where it is read at all) by the one caller that
 * has it — so they are named here.
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
