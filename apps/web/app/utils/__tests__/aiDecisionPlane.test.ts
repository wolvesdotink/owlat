import { describe, it, expect } from 'vitest';
import {
	DECISION_FALLBACK_SURFACES,
	DECISION_THRESHOLDS,
	DEFAULT_DECISION_KIND,
	SETUP_DEFAULT_DECISION_KIND,
	areDecisionThresholdsInert,
	decisionConsentOwed,
	decisionDegradedReasons,
	decisionEndpointHost,
	decisionKeyNotice,
	isBrandNewDecisionConfig,
	shouldSendDecisionConfig,
	validateDecisionConfig,
	type DecisionFormSnapshot,
} from '../aiDecisionPlane';
import { DECISION_PROVIDERS, decisionProviderOptions } from '../aiProviders';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * The decision card's rules, which are the rules of an OPT-IN: what an install
 * that never heard of this plane sends (nothing), what an operator is owed
 * before a third party is enabled (a consent block they have actually answered),
 * and when a probability may not be thresholded (whenever the plane is degraded,
 * said in words).
 *
 * The copy assertions run through the real English catalog, like the catalog
 * suite next door — a rule that answers with a key path nobody translated is a
 * card that shows the key path.
 */
const { t } = createTestI18n().global;

function snapshot(overrides: Partial<DecisionFormSnapshot> = {}): DecisionFormSnapshot {
	return {
		enabled: false,
		kind: 'llm',
		hasStoredKey: false,
		apiKey: '',
		consented: false,
		...overrides,
	};
}

describe('the two defaults stay separable', () => {
	it('recommends TypeSafe for a new install and resolves to the language plane without one', () => {
		// Collapsing these into one constant would turn a recommendation into a
		// migration for every install that never opted in.
		expect(SETUP_DEFAULT_DECISION_KIND).toBe('typesafe');
		expect(DEFAULT_DECISION_KIND).toBe('llm');
	});

	it('calls only an install with no config at all brand-new', () => {
		expect(isBrandNewDecisionConfig(null)).toBe(true);
		expect(isBrandNewDecisionConfig({ configured: false })).toBe(true);
		// An install that has a config but no decision plane is EXISTING: it gets
		// the option and no preselected vendor.
		expect(isBrandNewDecisionConfig({ configured: true })).toBe(false);
	});
});

describe('the catalog the picker offers', () => {
	it('offers the language model and TypeSafe, recommended first', () => {
		expect(DECISION_PROVIDERS.map((p) => p.kind)).toEqual(['typesafe', 'llm']);
		expect(DECISION_PROVIDERS.find((p) => p.kind === 'typesafe')?.recommended).toBe(true);
		expect(DECISION_PROVIDERS.find((p) => p.kind === 'llm')?.recommended).toBeUndefined();
	});

	it('names both options in words, with the recommendation inside the message', () => {
		const labels = decisionProviderOptions().map((option) => t(option.label));
		expect(labels).toEqual([
			'TypeSafe Jev (recommended)',
			'Use the language model (no third party)',
		]);
	});

	it('pins a version rather than an alias as the default model', () => {
		const typesafe = DECISION_PROVIDERS.find((p) => p.kind === 'typesafe');
		expect(typesafe?.defaultModel).toBe('jev-1.13.0');
		expect(typesafe?.curatedModels[0]).toBe('jev-1.13.0');
		// The language-backed adapter borrows the language plane's model; offering
		// a second one here would let the two disagree.
		expect(DECISION_PROVIDERS.find((p) => p.kind === 'llm')?.curatedModels).toEqual([]);
	});
});

describe('nothing is sent by an install that never opted in', () => {
	it('sends no decision arguments while the plane is off and none is stored', () => {
		expect(shouldSendDecisionConfig(snapshot())).toBe(false);
		expect(shouldSendDecisionConfig(snapshot({ kind: 'typesafe' }))).toBe(false);
	});

	it('sends the off-switch explicitly once a plane IS stored', () => {
		// An omitted `decisionProviderKind` means "leave it alone" on the backend,
		// so turning the card off has to travel as an explicit `'llm'` or the
		// vendor (and its key) would survive a save that claimed to remove it.
		expect(shouldSendDecisionConfig(snapshot({ enabled: false, storedKind: 'typesafe' }))).toBe(
			true
		);
	});

	it('sends nothing at all while the consent gate is unanswered', () => {
		const pending = snapshot({ enabled: true, kind: 'typesafe' });
		expect(shouldSendDecisionConfig(pending)).toBe(false);
		expect(shouldSendDecisionConfig({ ...pending, consented: true })).toBe(true);
	});
});

describe('consent is owed once per vendor, before it is enabled', () => {
	it('is owed when a keyed vendor is being turned on', () => {
		expect(decisionConsentOwed(snapshot({ enabled: true, kind: 'typesafe' }))).toBe(true);
	});

	it('is not owed again once that vendor is the stored one', () => {
		expect(
			decisionConsentOwed(snapshot({ enabled: true, kind: 'typesafe', storedKind: 'typesafe' }))
		).toBe(false);
	});

	it('is never owed for the language-backed adapter — nothing leaves', () => {
		expect(decisionConsentOwed(snapshot({ enabled: true, kind: 'llm' }))).toBe(false);
		expect(decisionConsentOwed(snapshot({ enabled: false, kind: 'typesafe' }))).toBe(false);
	});

	it('blocks the save in a sentence, not in a key path', () => {
		const key = validateDecisionConfig(snapshot({ enabled: true, kind: 'typesafe' }));
		expect(key).not.toBeNull();
		expect(t(key!)).toBe(
			'Read what leaves this deployment and tick the box before enabling a third-party decision provider.'
		);
	});

	it('clears once the box is ticked', () => {
		const consented = snapshot({ enabled: true, kind: 'typesafe', consented: true });
		expect(validateDecisionConfig(consented)).toBeNull();
	});
});

describe('a missing key is a note, never a block', () => {
	it('does not block a save — the key may come from the environment', () => {
		const noKey = snapshot({ enabled: true, kind: 'typesafe', consented: true });
		expect(validateDecisionConfig(noKey)).toBeNull();
		expect(t(decisionKeyNotice(noKey)!)).toContain('TYPESAFE_API_KEY');
	});

	it('says nothing once a key is stored or typed', () => {
		expect(
			decisionKeyNotice(snapshot({ enabled: true, kind: 'typesafe', hasStoredKey: true }))
		).toBeNull();
		expect(
			decisionKeyNotice(snapshot({ enabled: true, kind: 'typesafe', apiKey: ' sk-live ' }))
		).toBeNull();
	});

	it('says nothing for an adapter that needs no key of its own', () => {
		expect(decisionKeyNotice(snapshot({ enabled: true, kind: 'llm' }))).toBeNull();
	});
});

describe('the degraded state, in words', () => {
	it('calls the language-backed adapter uncalibrated', () => {
		const reasons = decisionDegradedReasons({ kind: 'llm', hasStoredKey: false });
		expect(reasons).toEqual(['languageBacked']);
		expect(t(`dashboard.admin.instance.aiProvider.decision.degraded.${reasons[0]}`)).toContain(
			'without a calibrated probability'
		);
	});

	it('reports a keyed adapter with no key as a missing key, not as uncalibrated', () => {
		expect(decisionDegradedReasons({ kind: 'typesafe', hasStoredKey: false })).toEqual([
			'keyMissing',
		]);
	});

	it('is clean for a keyed, keyed-up adapter', () => {
		expect(decisionDegradedReasons({ kind: 'typesafe', hasStoredKey: true })).toEqual([]);
		expect(areDecisionThresholdsInert({ kind: 'typesafe', hasStoredKey: true })).toBe(false);
	});

	it('lists every reason that stands, most structural first', () => {
		// An operator told only the first reason fixes it and finds the plane
		// still not answering.
		expect(
			decisionDegradedReasons({
				kind: 'llm',
				hasStoredKey: false,
				breakerOpen: true,
				lastTestFailed: true,
			})
		).toEqual(['languageBacked', 'breakerOpen', 'testFailed']);
	});

	it('makes the thresholds inert on any reason at all', () => {
		expect(
			areDecisionThresholdsInert({ kind: 'typesafe', hasStoredKey: true, breakerOpen: true })
		).toBe(true);
		expect(
			areDecisionThresholdsInert({ kind: 'typesafe', hasStoredKey: true, lastTestFailed: true })
		).toBe(true);
	});

	it('has real copy for every reason in the catalog', () => {
		for (const reason of ['languageBacked', 'keyMissing', 'breakerOpen', 'testFailed']) {
			const message = t(`dashboard.admin.instance.aiProvider.decision.degraded.${reason}`);
			expect(message.length).toBeGreaterThan(40);
			expect(message).not.toContain('dashboard.');
		}
	});
});

describe('the consent block names the host it will actually use', () => {
	it("uses the vendor's origin when nothing is overridden", () => {
		expect(decisionEndpointHost('typesafe')).toBe('api.typesafe.ai');
	});

	it("names the operator's proxy when they front the vendor with one", () => {
		expect(decisionEndpointHost('typesafe', 'https://ai-proxy.internal.example.com')).toBe(
			'ai-proxy.internal.example.com'
		);
	});

	it('hands back an unparseable override verbatim rather than the vendor host', () => {
		// Showing the vendor's host while the config points elsewhere is the one
		// lie a consent screen cannot afford.
		expect(decisionEndpointHost('typesafe', 'not a url')).toBe('not a url');
	});

	it('has no host to name for the adapter that talks to no third party', () => {
		expect(decisionEndpointHost('llm')).toBe('');
	});
});

describe('the per-surface fallback and the per-answer-type thresholds', () => {
	it('lets the operator decide the agent pipeline and nobody decide the classifiers', () => {
		expect(DECISION_FALLBACK_SURFACES.map((s) => [s.id, s.operatorControlled])).toEqual([
			['agent', true],
			['classifiers', false],
		]);
	});

	it('explains the classifier answer instead of greying a control out', () => {
		const classifiers = DECISION_FALLBACK_SURFACES.find((s) => s.id === 'classifiers')!;
		expect(t(classifiers.body)).toContain('not settable');
		expect(t(classifiers.body)).toContain('every message that arrives');
	});

	it('names thresholds per answer type and never as one confidence slider', () => {
		expect(DECISION_THRESHOLDS.map((threshold) => threshold.id)).toEqual(['noul', 'choice']);
		// A yes/no answer has no confidence field, so its threshold is a distance.
		expect(t(DECISION_THRESHOLDS[0]!.body)).toContain('distance from 0.5');
		expect(t(DECISION_THRESHOLDS[1]!.body)).toContain('confidence');
		expect(t(DECISION_THRESHOLDS[0]!.label)).toBe('Yes/no answers');
	});
});
