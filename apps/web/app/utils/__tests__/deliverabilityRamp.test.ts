/**
 * THE RELAY-REMOVAL CONSEQUENCE SENTENCE — one helper, three surfaces.
 *
 * The Independence screen, the transport editor's dialog and the apply
 * endpoint's refusal all name the same consequence for the same click, and an
 * operator meets at least two of them in a single attempt to disconnect. So the
 * facts-to-words step is pinned HERE, once, rather than three times in three
 * mounted screens: what it says about one dependent cell, about a count it does
 * not have, and about a relay it could not name.
 */
import { describe, expect, it } from 'vitest';
import { relayRemovalConsequenceCopy } from '~/utils/deliverabilityRamp';
import { independenceSubhead } from '~/utils/deliverabilityIndependenceCopy';
import { createTestI18n, localizedWith } from '~/__tests__/i18n';

/**
 * Both helpers are module scope, so they hand back the catalog key plus the
 * relay name they interpolate. The suite renders them through the real English
 * catalog — the wording is the whole subject here.
 */
const { t } = createTestI18n().global;
const localized = localizedWith(t);

const REFERENCE = 'ses';

describe('relayRemovalConsequenceCopy', () => {
	it('agrees with itself about one cell — subject, verb and possessive', () => {
		const { consequence: sentence } = relayRemovalConsequenceCopy({
			dependentCells: ['campaign:gmail'],
			referenceTransportId: REFERENCE,
			projectedSafeAt: null,
		});

		expect(localized(sentence)).toContain('1 cell has not graduated yet');
		expect(localized(sentence)).toContain('still sends part of its mail through Amazon SES');
		// The defect this pins: "1 cells have not graduated yet", shipped on two
		// screens while the server's own refusal got it right.
		expect(localized(sentence)).not.toContain('1 cells');
	});

	it('pluralises past one', () => {
		const { consequence: sentence } = relayRemovalConsequenceCopy({
			dependentCells: ['campaign:gmail', 'automation:yahoo'],
			referenceTransportId: REFERENCE,
			projectedSafeAt: null,
		});

		expect(localized(sentence)).toContain('2 cells have not graduated yet');
		expect(localized(sentence)).toContain('still send part of their mail through Amazon SES');
	});

	it('names the consequence itself, not the risk in general', () => {
		const { consequence: sentence } = relayRemovalConsequenceCopy({
			dependentCells: ['campaign:gmail'],
			referenceTransportId: REFERENCE,
			projectedSafeAt: null,
		});

		expect(localized(sentence)).toContain('immediately — not gradually');
		expect(localized(sentence)).toContain('stops being available to fall back on');
	});

	it('says the situation could not be established rather than claiming zero cells', () => {
		// A COUNT WE DO NOT HAVE IS NOT ZERO. This is the shape behind the
		// endpoint's fail-closed refusal — nothing was read, so nothing may be
		// asserted about which cells are safe.
		const { consequence: sentence } = relayRemovalConsequenceCopy({
			dependentCells: null,
			referenceTransportId: null,
			projectedSafeAt: null,
		});

		expect(localized(sentence)).toContain('could not be established');
		expect(localized(sentence)).not.toContain('0 cell');
		expect(localized(sentence)).toContain('immediately — not gradually');
	});

	it('says a read that found every cell graduated is safe, not unestablished', () => {
		// AND ZERO IS NOT A COUNT WE DO NOT HAVE. An empty list is an ANSWER, and
		// routing it through the unknown arm made the Independence dialog refuse to
		// call safe a deployment the card above the button had just called safe.
		const { consequence: sentence, safeDate } = relayRemovalConsequenceCopy({
			dependentCells: [],
			referenceTransportId: REFERENCE,
			projectedSafeAt: null,
		});

		expect(localized(sentence)).toContain('Every cell has graduated');
		expect(localized(sentence)).toContain('would not move any traffic');
		expect(localized(sentence)).not.toContain('could not be established');
		expect(localized(sentence)).not.toContain('cannot be treated as safe');
		// The one thing disconnecting still costs a graduated deployment.
		expect(localized(sentence)).toContain('stops being available to fall back on');
		expect(safeDate).toBeNull();
	});

	it('calls an unnamed second arm the relay rather than printing null', () => {
		const { consequence: sentence } = relayRemovalConsequenceCopy({
			dependentCells: null,
			referenceTransportId: null,
			projectedSafeAt: null,
		});

		expect(localized(sentence)).toContain('the relay');
		expect(localized(sentence)).not.toContain('null');
	});

	it('offers the projected safe date only when the projection has one', () => {
		const at = Date.UTC(2026, 7, 14);
		expect(
			localized(
				relayRemovalConsequenceCopy({
					dependentCells: ['campaign:gmail'],
					referenceTransportId: REFERENCE,
					projectedSafeAt: at,
				}).safeDate!
			)
		).toContain('waiting until about');
		expect(
			relayRemovalConsequenceCopy({
				dependentCells: ['campaign:gmail'],
				referenceTransportId: REFERENCE,
				projectedSafeAt: null,
			}).safeDate
		).toBeNull();
	});
});

/**
 * THE RELAY HAS A NAME, AND THE PROSE USES IT.
 *
 * `referenceTransportId` is the stored transport id — `ses`, `smtp`,
 * `plugin.<pack>.<id>` — which is what the operator configured, not what the
 * product calls that transport anywhere else. Printing it verbatim put "instead
 * of ses" on the screen people screenshot while the transport card, three clicks
 * away, called the same thing "Amazon SES". The naming itself is pinned in
 * `transportState.test.ts`; these are the sentences it lands in.
 */
describe('naming the reference transport', () => {
	/** The relay sentence, for a deployment with exactly one relay to name. */
	function subheadFor(referenceTransportId: string): string {
		return localized(independenceSubhead({ isRelayConfigured: true, referenceTransportId }));
	}

	it('names the relay the way the transport card does', () => {
		expect(subheadFor('ses')).toContain('instead of Amazon SES');
		expect(subheadFor('smtp')).toContain('instead of SMTP relay');
		expect(subheadFor('ses')).not.toContain(' ses');
	});

	it('never prints a namespaced plugin id in a sentence', () => {
		const subhead = subheadFor('plugin.mail-pack.postmark');
		expect(subhead).toContain('instead of Postmark');
		expect(subhead).not.toContain('plugin.');
	});

	it('falls back to the raw id rather than dropping an unknown transport', () => {
		// The reference arm is whatever `EMAIL_PROVIDER` was set to, so an id this
		// build does not know must still read as itself.
		expect(subheadFor('postmark')).toContain('instead of postmark');
		expect(
			localized(
				relayRemovalConsequenceCopy({
					dependentCells: ['campaign:gmail'],
					referenceTransportId: 'postmark',
					projectedSafeAt: null,
				}).consequence
			)
		).toContain('through postmark');
	});

	it('names the relay in the removal consequence too', () => {
		expect(
			localized(
				relayRemovalConsequenceCopy({
					dependentCells: ['campaign:gmail'],
					referenceTransportId: 'plugin.mail-pack.postmark',
					projectedSafeAt: null,
				}).consequence
			)
		).toContain('through Postmark');
	});

	it('leaves the standalone sentence alone — there is no relay to name', () => {
		expect(
			localized(independenceSubhead({ isRelayConfigured: false, referenceTransportId: null }))
		).toContain('There is no relay to move away from');
	});

	/**
	 * TWO RELAYS: a name it cannot give, on a screen that is still about a relay
	 * (#513). The sentence is chosen by whether a relay EXISTS, so the unnamed
	 * case says "the relays you have connected" rather than falling through to the
	 * standalone promise that there is nothing to move away from.
	 */
	it('speaks of the relays in the plural when no single one can be named', () => {
		const subhead = localized(
			independenceSubhead({ isRelayConfigured: true, referenceTransportId: null })
		);
		expect(subhead).toContain('instead of the relays you have connected');
		expect(subhead).not.toContain('There is no relay to move away from');
	});
});
