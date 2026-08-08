/**
 * THE SIGNAL-SOURCE CONTRACT (seams plan D9).
 *
 * A signal source is one answer to "where does this deployment's evidence about
 * its own deliverability come from" — the ramp's own outcome counters, the
 * SMTP-level defers the MTA sees, a provider's reputation feed. Before this
 * module each source was a module the readers named by hand, so "which sources
 * exist" had no answer in the tree and "what happens when this one is not
 * configured" was a paragraph in each module's docstring rather than a field
 * anything could check.
 *
 * THREE THINGS EVERY SOURCE DECLARES:
 *
 *  1. `key` — the source's name in the ONE deliverability vocabulary
 *     (`@owlat/shared/deliverabilityRouting`), widened only by the provider
 *     feeds below, which are not routing signals and have no key there.
 *  2. `kind` — `infrastructure` / `outcome` / `advisory`, the shared
 *     vocabulary's own three families, in the shared vocabulary's own sense:
 *     what the reading is ALLOWED TO DO. Infrastructure flips the shipped relay
 *     fallback; outcome moves the ramp controller's share; advisory is recorded
 *     and readable and moves nothing on its own. It is not a taxonomy of how the
 *     evidence was gathered — a provider's complaint feed is advisory here
 *     because no decision path consults it, not because complaints are advice.
 *  3. `absence` — what happens when the source is NOT CONFIGURED, declared as
 *     data. "Not configured" is a supported verdict (plan D2): every absence
 *     carries `isBlocking: false` by TYPE, so a source that blocked on its own
 *     absence could not be declared at all.
 *
 * WHY ABSENCE IS A FIELD AND NOT A DOCSTRING. Two of the three provider feeds
 * already encoded exactly this invariant one module at a time
 * (`SNDS_ABSENT_SUBSTITUTION.isBlocking`, `YahooComplaintSubstitution.isBlocking`,
 * both "encoded as a field rather than left implicit so the D2 invariant is
 * asserted by a test rather than assumed by a reader"). This is that idea with
 * one home: the registry test walks every source and asks it, so a source added
 * next year answers the question whether or not its author read the plan.
 *
 * NO PLUGIN BUCKET. Third-party signal sources are deliberately deferred — the
 * registry is the seam; opening it to plugins is its own piece, on the day
 * someone wants it.
 */

import type { DeliverabilitySignalSource } from '@owlat/shared/deliverabilityRouting';
import type { RampSubstituteSource } from '../ramp/degradationMatrix';

/**
 * The three families, from `@owlat/shared/deliverabilityRouting`. Restated as a
 * kind union rather than imported because shared declares the families as three
 * arrays of SOURCE KEYS and never names the families themselves; the registry
 * test pins each declared kind against the shared classifier so the two cannot
 * drift.
 */
export const SIGNAL_SOURCE_KINDS = ['infrastructure', 'outcome', 'advisory'] as const;
export type SignalSourceKind = (typeof SIGNAL_SOURCE_KINDS)[number];

/**
 * The RAMP'S OWN measurements, named in the shared vocabulary.
 *
 * `satisfies` is the whole point of the annotation: these five are keys of
 * `DeliverabilitySignalSource`, so a rename in shared stops compiling here
 * instead of quietly forking the vocabulary the routing plane and the ramp are
 * supposed to share. The list is deliberately a SUBSET — the shipped relay
 * triggers (`ip_quarantined`, `dnsbl_*`) are recorded by the routing plane and
 * have no collector here, and a registry entry for a source nothing collects
 * would be a promise the tree does not keep.
 *
 * THE ORDER IS THIS ARRAY'S OWN, not shared's: the keys are shared's, but the
 * sequence is the plan's gate numbering (1 hard bounce … 5 seed placement), and
 * `rampGateSources` folds in it, so the FIRST breach at the winning rank — the
 * one the operator is shown — is decided here and nowhere else.
 */
export const RAMP_GATE_SIGNAL_KEYS = [
	'bounce_rate',
	'persistent_defers',
	'complaint_rate',
	'engagement_ratio',
	'seed_placement',
] as const satisfies readonly DeliverabilitySignalSource[];
export type RampGateSignalKey = (typeof RAMP_GATE_SIGNAL_KEYS)[number];

/**
 * The provider REPUTATION FEEDS — third-party accounts an operator may or may
 * not have, and the reason absence semantics are part of this contract at all.
 *
 * They are not `DeliverabilitySignalSource`s: that union is the vocabulary of
 * what can move the shipped relay fallback and the ramp's share, and a feed
 * moves neither (see each source's `kind`). Keeping them in a separate union
 * means widening this one can never widen what routing acts on.
 */
export const PROVIDER_FEED_SIGNAL_KEYS = ['snds', 'yahoo_cfl', 'google_postmaster'] as const;
export type ProviderFeedSignalKey = (typeof PROVIDER_FEED_SIGNAL_KEYS)[number];

export type SignalSourceKey = RampGateSignalKey | ProviderFeedSignalKey;

/**
 * WHAT AN ABSENT SOURCE DOES — one of three, and never a fourth: blocking is
 * unrepresentable.
 *
 *  - `substitute` — a weaker signal stands in and the reading continues, more
 *    slowly and with a lower confidence that is said out loud (plan D14).
 *  - `hold` — the source still answers, and its answer is "not enough evidence
 *    this window", which neither advances nor retreats the ramp (plan D10).
 *  - `omit` — the source contributes nothing at all: nothing is measured, so
 *    nothing is folded, so an absent source cannot hold anything either.
 *
 * ONE PLANE, AND IT IS THE COLLECTION PLANE. This is what `collect()` hands back
 * when it has no reading — what the CALLER of this source gets, and nothing
 * else. It is deliberately NOT the ramp-level price of an absent integration:
 * how much longer a cell dwells, how many clean windows it needs, how far its
 * ceiling drops and which OTHER gates take over have exactly one home, the
 * `RAMP_DEGRADATION_MATRIX` in `../ramp/degradationMatrix`, and a second
 * statement of any of it here would be free to disagree with the card the
 * operator is reading beside it. So `google_postmaster` can declare `omit` (no
 * observation, no cards) while the matrix's `google_postmaster` entry doubles
 * the Gmail cell's dwell: those are answers to two different questions, and the
 * registry only ever answers the first.
 *
 * Where an absence DOES name a stand-in, the name comes from that same matrix's
 * `RAMP_SUBSTITUTE_SOURCES` vocabulary, so "what is this cell running on" reads
 * the same word on the gate row, the degradation card and this inventory.
 */
export type SignalAbsence =
	| {
			readonly behaviour: 'substitute';
			/**
			 * What stands in, in the ONE substitute vocabulary the degradation table
			 * and the dashboard already use. A bare string here let two feeds spell
			 * the same stand-in differently and a typo in either compile.
			 */
			readonly substitutes: RampSubstituteSource;
			/** The operator-visible sentence, taken from the substitution, never restated. */
			readonly note: string;
			readonly isBlocking: false;
	  }
	| { readonly behaviour: 'hold'; readonly note: string; readonly isBlocking: false }
	| { readonly behaviour: 'omit'; readonly note: string; readonly isBlocking: false };

/**
 * A collection attempt's answer: the reading, or the declared absence that
 * explains why there is none. The absent arm carries an absence rather than a
 * bare `null` so the caller has the substitution and the sentence to render
 * without asking a second module what "no reading" meant here.
 */
export type SignalCollection<Reading> =
	| { readonly available: true; readonly reading: Reading }
	| { readonly available: false; readonly absence: SignalAbsence };

export function signalPresent<Reading>(reading: Reading): SignalCollection<Reading> {
	return { available: true, reading };
}

export function signalAbsent<Reading>(absence: SignalAbsence): SignalCollection<Reading> {
	return { available: false, absence };
}

/**
 * What every source declares, whatever it collects.
 *
 * The registry is typed to THIS rather than to `SignalSource`: the readings are
 * genuinely different shapes (a gate result, a complaint band, a list of
 * operator cards), and an inventory that erased them into one would force every
 * consumer to cast its way back out. Consumers that need a reading import the
 * source itself, or the typed sub-registry their evaluation iterates.
 */
export interface SignalSourceDeclaration {
	readonly key: SignalSourceKey;
	readonly kind: SignalSourceKind;
	/**
	 * THE ABSENCE WITH NOTHING ELSE CONFIGURED — the worst case, which is the only
	 * one a static inventory can state. A source whose stand-in depends on what
	 * else the deployment has (`yahoo_cfl` falls to the CFBL feed if a send
	 * carried one, otherwise to the unsubscribe proxy) declares the weakest of
	 * them here and hands back the one that is ACTUALLY live from `collect()`.
	 * Rendering a specific cell's absence means asking `collect()`; reading this
	 * field means asking "what does a deployment that configured nothing get".
	 */
	readonly absence: SignalAbsence;
}

/** A declared source plus the collection it performs. */
export interface SignalSource<Input, Reading> extends SignalSourceDeclaration {
	collect(input: Input): SignalCollection<Reading>;
}
