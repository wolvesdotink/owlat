/**
 * THE SENTENCE UNDER A GATE'S VERDICT — units, and the two places they change.
 *
 * `gateExplanation` renders the numbers an operator acts on, and under plan D12
 * the same fields feed the audit row and the admin notification. Almost every
 * verdict is denominated in SENDS, and the generic sentence says so in words —
 * so the exceptions have to be branched on rather than assumed away. There are
 * exactly two: the block-message hard stop counts CLASSIFIED SMTP RESPONSES, and
 * the seed-placement gate counts SEED PROBES. Printing "24 sends" under a verdict
 * that stopped a cell — or "10 sends" under a placement tripwire whose whole
 * sample is ten probes — is a number the operator would act on and be wrong
 * about.
 *
 * THE BLOCK-MESSAGE BRANCH IS REACHABLE SERVER-SIDE (issue #501) — the MTA's
 * classified responses land in a per-(cell, arm, day) counter that both readers
 * of the gate input summarize, so a standalone cell whose window is at least 0.5%
 * refusals renders this sentence. It was pinned through the whole time it could
 * not, because the unit is the part that would have been got wrong when the halt
 * arrived, and a branch nobody covers is a branch that comes back as "24 sends".
 *
 * AND A PROBE IS NOT A MAILBOX. `seedShadowCopy.ts` writes one probe per seed
 * mailbox per campaign send, so the window's sample is mailboxes times sends;
 * "80 seed mailboxes" under a deployment that has eight would overstate the
 * coverage by the send cadence, on the one field D17 keeps precisely because it
 * is the honesty input.
 *
 * AND THE SEED GATE MAY NOT QUOTE A RATE AT ALL (plan D17). Its unit is right
 * and its sentence is still a gauge if it prints a share against a threshold, so
 * the placement suite below asserts the ABSENCE of one alongside the words that
 * replace it.
 *
 * The hold vocabulary is covered here too, because the switch is exhaustive on
 * purpose: a new `RampGateHoldReason` must arrive with its own sentence, and a
 * sentence that reads like a fault under a reason that is not one is the D2
 * failure mode ("nothing merely UNMEASURED is rendered as a problem").
 */

import { describe, expect, it } from 'vitest';
import {
	blockMessageHalt,
	failingGate,
	holdingGate,
	passingGate,
	seedPlacementGate,
	seedPlacementHold,
	seedPlacementPass,
	seedPlacementReferenceBreach,
	seedPlacementReferenceBreachOutgrown,
	seedPlacementReferenceHold,
} from '~/components/delivery/__tests__/measurementFixtures';
import { gateExplanation } from '~/utils/deliverabilityGateCopy';
import {
	improvementCopy,
	measurementSubhead,
	standaloneNote,
	type DeliverabilityDashboardGate,
	type LocalizedText,
} from '~/utils/deliverabilityMeasurement';
import { createTestI18n } from '~/__tests__/i18n';
import { decisionWindowLabel, reportedWindowLabel } from '~/utils/deliverabilityWindows';
import { formatShortDate } from '~/utils/formatters';

/**
 * Every sentence in this module is module scope, so it arrives as the catalog
 * key plus the numbers it interpolates. The suite renders each one through the
 * real English catalog, because the unit nouns it pins live in the copy.
 */
const { t } = createTestI18n().global;
const localized = (value: LocalizedText): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
const explain = (gate: DeliverabilityDashboardGate): string => localized(gateExplanation(gate));
const noteFor = (input: Parameters<typeof standaloneNote>[0]): string =>
	localized(standaloneNote(input));

/**
 * THE SECOND ARM IS NAMED, NOT KEYED. `referenceTransportId` arrives as the
 * stored transport id, so the shipped subhead read "compares with ses" on the
 * screen an operator screenshots while the transport card called the same relay
 * "Amazon SES". The naming itself is pinned in `transportState.test.ts`; this is
 * the sentence it lands in.
 */
describe('measurementSubhead', () => {
	const measured = (referenceTransportId: string | null): string =>
		localized(measurementSubhead({ hasReferenceArm: true, referenceTransportId }));

	it('names the relay the way the transport card does', () => {
		expect(measured('ses')).toContain('compares with Amazon SES');
		expect(measured('plugin.mail-pack.postmark')).toContain('compares with Postmark');
		expect(measured('ses')).not.toContain(' ses ');
	});

	it('falls back to the raw id rather than dropping an unknown transport', () => {
		expect(measured('postmark')).toContain('compares with postmark');
	});

	it('leaves the standalone sentence alone — there is no relay to compare with', () => {
		expect(
			localized(measurementSubhead({ hasReferenceArm: false, referenceTransportId: null }))
		).toContain('What your own server is sending');
	});

	it('still says a comparison happened when no single relay can be named', () => {
		// TWO RELAY KINDS: the configuration has no single arm to name and every
		// cell is still measured against one. Keyed to the id alone this screen
		// claimed the deployment sends entirely from its own server.
		const subhead = localized(
			measurementSubhead({ hasReferenceArm: true, referenceTransportId: null })
		);
		expect(subhead).toContain('compares with the relays carrying the same traffic');
		expect(subhead).not.toContain('What your own server is sending');
	});

	it('drops to the standalone sentence for a named relay that carried nothing', () => {
		// The divergence the other way: a relay is configured, no cell was measured
		// against it, and the gates below graded every cell standalone.
		expect(
			localized(measurementSubhead({ hasReferenceArm: false, referenceTransportId: 'ses' }))
		).toContain('What your own server is sending');
	});
});

/**
 * THE NOTE IS SHOWN ON THE MEASUREMENT AND WORDED ON THE CONFIGURATION.
 *
 * The note itself only renders where no cell measured a second arm; what it SAYS
 * is a question about the relay list, because "connect a relay you already pay
 * for" is advice a deployment with a relay cannot act on. Its closing sentence
 * is a third fact again — a promise about bars on the cards below, which only
 * some of these deployments have.
 */
describe('standaloneNote', () => {
	it('offers a relay only where there is none to have gone quiet', () => {
		const note = noteFor({
			isRelayConfigured: false,
			referenceTransportId: null,
			hasPlottedRelayHistory: false,
		});
		expect(note).toContain('Connecting a relay you already pay for');
		expect(note).toContain('optional');
		// An invitation, never a warning or a "setup incomplete" nag (plan D2).
		expect(note).not.toMatch(/error|incomplete|required|must/i);
	});

	it('explains a named relay that went quiet instead of offering to connect it', () => {
		// THE CONTRADICTION THIS PINS: keyed to the measurement, this sentence
		// offered SES to a deployment already relaying through SES, directly above
		// a card saying that SES carried the cell earlier in this window.
		const note = noteFor({
			isRelayConfigured: true,
			referenceTransportId: 'ses',
			hasPlottedRelayHistory: true,
		});
		expect(note).not.toContain('Connecting a relay');
		expect(note).toContain('Amazon SES carried none of this traffic recently');
		expect(note).toContain('The days it did carry are still plotted');
		expect(note).not.toMatch(/error|incomplete|required|must/i);
	});

	it('promises no plotted days where no card plots one', () => {
		// A graduated deployment (every cell at full own share), a relay connected
		// today, a relay enabled for a messageType outside these streams: the relay
		// is configured and carried nothing anywhere in the seven days the cards
		// plot, so the explanation stands and the promise about the bars does not.
		const note = noteFor({
			isRelayConfigured: true,
			referenceTransportId: 'ses',
			hasPlottedRelayHistory: false,
		});
		expect(note).toContain('Amazon SES carried none of this traffic recently');
		expect(note).not.toContain('still plotted');
		expect(note).not.toContain('Connecting a relay');
	});

	it('speaks of relays in the plural when there is no single one to name', () => {
		// The two-relay deployment: a relay exists, so the offer is still wrong,
		// and `referenceTransportId` is null for the OTHER reason.
		const note = noteFor({
			isRelayConfigured: true,
			referenceTransportId: null,
			hasPlottedRelayHistory: true,
		});
		expect(note).not.toContain('Connecting a relay');
		expect(note).toContain('the relays you have connected carried none of this traffic');
		expect(note).toContain('The days they did carry');
	});

	it('drops the plural promise on the same premise', () => {
		const note = noteFor({
			isRelayConfigured: true,
			referenceTransportId: null,
			hasPlottedRelayHistory: false,
		});
		expect(note).toContain('the relays you have connected carried none of this traffic');
		expect(note).not.toContain('still plotted');
	});

	it('names a plugin relay the way the transport card does', () => {
		expect(
			noteFor({
				isRelayConfigured: true,
				referenceTransportId: 'plugin.mail-pack.postmark',
				hasPlottedRelayHistory: true,
			})
		).toContain('Postmark carried none');
	});
});

describe('gateExplanation — units', () => {
	it('denominates an ordinary verdict in sends', () => {
		expect(explain(passingGate())).toContain('over 1,000 sends');
		expect(explain(failingGate())).toContain('over 1,200 sends');
	});

	it('never calls a classified SMTP response a send', () => {
		const sentence = explain(blockMessageHalt());
		expect(sentence).toContain('240 classified SMTP responses');
		expect(sentence).toContain('block messages');
		// THE DEFECT THIS PINS: the generic branch would have printed "over 240
		// sends", and 240 is a response count.
		expect(sentence).not.toContain('sends');
	});

	it('still reports the limit the halt compared against', () => {
		expect(explain(blockMessageHalt())).toContain('0.50%');
	});

	it('prints the own sample against its floor in the SAME unit on a hold', () => {
		expect(explain(holdingGate())).toContain('124 of 400 sends');
	});

	it('never calls a seed probe a send, on either sentence', () => {
		// `evaluateSeedGate` denominates BOTH `ownSample` and `minSample` in seed
		// probes, so the decided sentence and the below-floor hold are both wrong
		// under the generic noun.
		const decided = explain(seedPlacementGate());
		expect(decided).toContain('10 seed probes');
		expect(decided).not.toContain('sends');

		const held = explain(seedPlacementHold());
		expect(held).toContain('8 of 20 seed probes');
		expect(held).not.toContain('sends');

		// THE THIRD SENTENCE. The comparison sweep is thin, and its sample is seed
		// probes too — the reason names the OTHER series, not another unit.
		const referenceHeld = explain(seedPlacementReferenceHold());
		expect(referenceHeld).toContain('3 of 5 seed probes');
		expect(referenceHeld).not.toContain('sends');
	});

	it('never calls a seed probe a mailbox — the count runs with the send cadence', () => {
		// THE DEFECT THIS PINS. `ownSample` is `SeedProviderRollup.sampleSize`,
		// which `readArmCounts` sums out of PER-PLACEMENT PROBE COUNTS, and
		// `seedShadowCopy.ts` writes one probe per connected seed mailbox per
		// campaign send. So a deployment with 8 seed mailboxes and 10 campaigns in
		// the window renders 80 — a sentence saying "80 seed mailboxes" claims a
		// coverage ten times what the operator connected, on the one number D17
		// keeps BECAUSE it is the honesty input. Every seed sentence is checked,
		// including the fall-through, because the noun is the whole point.
		const wide = { ...seedPlacementPass().measurement, ownSample: 80, referenceSample: 80 };
		const sentences = [
			explain({ ...seedPlacementPass(), measurement: wide }),
			explain({ ...seedPlacementGate(), measurement: wide }),
			explain({ ...seedPlacementReferenceBreach(), measurement: wide }),
			explain(seedPlacementHold()),
			explain(seedPlacementReferenceHold()),
			explain({ ...seedPlacementReferenceBreach(), reason: 'trailing_baseline_breached' }),
		];
		for (const sentence of sentences) {
			expect(sentence).toContain('seed probes');
			expect(sentence).not.toContain('mailbox');
		}
		// The mailbox NOUN still belongs to the fact that is actually about
		// mailboxes — the improvement invitation, which counts connected accounts.
		expect(localized(improvementCopy('add_seed_mailboxes'))).toContain('seed mailboxes');
	});
});

/**
 * D17 — SEEDS ARE A TRIPWIRE, NOT A GAUGE.
 *
 * `seedPlacementGate.ts` keeps both arms' shares inside itself and hands out a
 * STATUS; `placementAdapter.ts` takes COUNTS from a commercial panel, "never a
 * percentage". A screen that renders the same verdict as "85.00% … against a
 * limit of 90.00%" is a third answer neither module would give — and one probe
 * in a ten-probe sweep moves it ten points.
 */
describe('gateExplanation — the seed gate states a status, never a placement rate', () => {
	const PERCENTAGE = /\d\s*%|\d+\.\d+%/;

	it('quotes no share, threshold or tolerance on a decided placement verdict', () => {
		for (const gate of [seedPlacementPass(), seedPlacementGate(), seedPlacementReferenceBreach()]) {
			const sentence = explain(gate);
			expect(sentence).not.toMatch(PERCENTAGE);
			// The three numbers the shipped sentence leaked: the own share, the
			// inbox floor, and the reference tolerance in percentage points.
			expect(sentence).not.toContain('85');
			expect(sentence).not.toContain('90');
			expect(sentence).not.toContain('limit');
		}
	});

	it('says a clean sweep reached the inbox OR A TAB, in probes', () => {
		// `isSeedPlacementReached` counts `category` — a Gmail tab — as reached, and
		// `inbox_dominant` is documented as "the inbox or a tab". "Reached the inbox"
		// alone reports a Promotions-filed probe as a miss the gate did not find.
		const sentence = explain(seedPlacementPass());
		expect(sentence).toContain('Effectively all of the 10 seed probes reached the inbox or a tab');
	});

	it('says an absolute breach missed, and covers every placement that counts as missing', () => {
		const sentence = explain(seedPlacementGate());
		expect(sentence).toContain('Some of the 10 seed probes did not reach the inbox or a tab');
		// Not-reached is spam, deleted OR missing — the shipped sentence named two
		// of the three and left an auto-deleted probe unaccounted for.
		expect(sentence).toContain('filtered to spam, deleted, or not found in any folder');
	});

	it('states the comparative breach as a rate comparison, with the sweeps beside it', () => {
		// `reference_tolerance_breached` is the one seed verdict about the RELAY, and
		// it compares two SHARES over independently-sized sweeps. The sizes are
		// context; the size of the GAP is the number D17 forbids quoting.
		const sentence = explain(seedPlacementReferenceBreach());
		expect(sentence).toContain('less often than the comparison transport');
		expect(sentence).toContain('10 swept here, 12 there');
		expect(sentence).not.toContain('Comparison transport:');
	});

	it('invents no baseline story for a decided reason the seed gate does not produce', () => {
		// `trailing_baseline_breached` is in the shared fail-reason union but is the
		// ENGAGEMENT and CEILING gates' word: `seedGate.ts` decides exactly
		// `within_threshold`, `absolute_threshold_breached` and
		// `reference_tolerance_breached`, and the standalone evaluator drops the
		// comparative clause rather than swapping a baseline one in. So a seed
		// verdict carrying it gets the status word and the sweep size — never a
		// sentence about "its own recent sweeps" that no gate computed.
		const sentence = explain({
			...seedPlacementReferenceBreach(),
			reason: 'trailing_baseline_breached',
		});
		expect(sentence).toBe('Needs attention — this check swept 10 seed probes.');
		expect(sentence).not.toContain('own recent sweeps');
		expect(sentence).not.toMatch(PERCENTAGE);
	});

	it('stays true when the own sweep has outgrown the comparison one', () => {
		// THE DEFECT THIS PINS: 16 of 20 here against 5 of 5 there breaches the
		// tolerance, and MORE probes reached the inbox on this side — so the
		// count-flavoured "fewer of ours reached than of theirs" was a false
		// sentence, in the ordinary late-ramp shape rather than an exotic one.
		const sentence = explain(seedPlacementReferenceBreachOutgrown());
		expect(sentence).toContain('less often than the comparison transport');
		expect(sentence).toContain('20 swept here, 5 there');
		expect(sentence).not.toContain('Fewer');
		expect(sentence).not.toMatch(PERCENTAGE);
	});
});

describe('gateExplanation — a hold is never rendered as a fault', () => {
	type HoldingGate = Extract<DeliverabilityDashboardGate, { status: 'insufficient_data' }>;

	/** A hold with a chosen reason. Written out rather than spread: the union's
	 * `reason` narrows with `status`, and a spread would widen both back. */
	function held(reason: HoldingGate['reason']): DeliverabilityDashboardGate {
		return {
			gate: 'hard_bounce',
			status: 'insufficient_data',
			reason,
			measurement: {
				thresholdRate: 0.02,
				toleranceValuePp: 0.5,
				ownSample: 124,
				referenceSample: null,
				minSample: 400,
				ownRate: null,
				referenceRate: null,
			},
			confidence: 'high',
			mayJustifyIncrease: true,
		};
	}

	const HOLD_REASONS: readonly HoldingGate['reason'][] = [
		'own_sample_below_floor',
		'reference_sample_below_floor',
		'baseline_sample_below_floor',
		'own_evidence_stale',
		'reference_evidence_stale',
		'baseline_evidence_stale',
		'own_rate_unmeasurable',
		'reference_rate_unmeasurable',
		'baseline_rate_unmeasurable',
		'reference_not_a_denominator',
		'baseline_not_a_denominator',
		'own_deferral_telemetry_absent',
		'evidence_absent',
	];

	for (const reason of HOLD_REASONS) {
		it(`${reason} renders a sentence, never an error`, () => {
			const sentence = explain(held(reason));
			expect(sentence.length).toBeGreaterThan(0);
			expect(sentence).not.toContain('undefined');
			const lower = sentence.toLowerCase();
			for (const word of ['error', 'failed', 'incomplete', 'required']) {
				expect(lower).not.toContain(word);
			}
		});
	}

	it('says an uninstrumented deferral counter is unmeasured, not a zero rate', () => {
		// The hold exists because "0% deferrals" and "nothing counts deferrals here"
		// produce the identical number, and the operator has to be able to tell them
		// apart on the screen — so the sentence must not read as a healthy window,
		// and must not borrow the thin-sample story either.
		const uninstrumented = explain(held('own_deferral_telemetry_absent'));
		expect(uninstrumented).toContain('recorded');
		expect(uninstrumented).not.toBe(explain(held('own_sample_below_floor')));
		expect(uninstrumented).not.toBe(explain(held('evidence_absent')));
		expect(uninstrumented).not.toMatch(/\d+%/);
	});

	it('says a clean comparison window is clean, not corrupt', () => {
		// `*_not_a_denominator` and `*_rate_unmeasurable` are two different stories
		// and must not share one sentence: one sends the operator to investigate a
		// poisoned bucket, the other says there is simply nothing to divide by.
		const clean = explain(held('baseline_not_a_denominator'));
		const poisoned = explain(held('baseline_rate_unmeasurable'));
		expect(clean).not.toBe(poisoned);
		expect(clean).toContain('too clean');
	});
});

/**
 * THE TWO SPANS ARE NAMED FROM THE SERVER'S BOUNDS (#510).
 *
 * The screen reports counters over a week and renders verdicts reached over the
 * ramp controller's own window. Both labels are DERIVED — a screen holding its
 * own copy of "24 hours" would keep printing it after the controller's cadence
 * moved, which is the drift the server-side fix removed.
 */
describe('the reported window and the deciding span, in words', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const END = Date.UTC(2026, 6, 16);

	it('names the last day the reported window actually includes', () => {
		// `windowEnd` is EXCLUSIVE: a label naming it would claim a day of data
		// that is not in any number on the screen. Asserted against the formatter
		// rather than against literal dates, so the pin holds in every timezone.
		const label = reportedWindowLabel({ windowStart: END - 7 * DAY, windowEnd: END });
		expect(label).toBe(`${formatShortDate(END - 7 * DAY)} – ${formatShortDate(END - 1)}`);
	});

	it('reads the deciding span off the bounds rather than assuming a day', () => {
		expect(decisionWindowLabel({ decisionWindowStart: END - DAY, decisionWindowEnd: END })).toBe(
			'the last 24 hours'
		);
		// A cadence change renames the label instead of leaving a stale number.
		expect(
			decisionWindowLabel({
				decisionWindowStart: END - 6 * 60 * 60 * 1000,
				decisionWindowEnd: END,
			})
		).toBe('the last 6 hours');
		expect(
			decisionWindowLabel({ decisionWindowStart: END - 3 * DAY, decisionWindowEnd: END })
		).toBe('the last 3 days');
	});

	it('never renders a nonsense span as a number', () => {
		// A degenerate or reversed pair is a fault in the read, not a licence to
		// print "the last 0 hours" under every verdict on the screen.
		expect(decisionWindowLabel({ decisionWindowStart: END, decisionWindowEnd: END })).toBe(
			'the latest measurements'
		);
		expect(decisionWindowLabel({ decisionWindowStart: Number.NaN, decisionWindowEnd: END })).toBe(
			'the latest measurements'
		);
	});
});
