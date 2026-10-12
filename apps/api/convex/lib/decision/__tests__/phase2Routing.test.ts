/**
 * When a Phase 2 bundle runs, on which rung, and the block-only verdict rule
 * (ADR-0073 §5, §8). Pure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRoutingPolicy } from '@owlat/shared/aiRouting';
import {
	advisoryProjection,
	artifactKeyOf,
	decisionRung,
	planMessageBundle,
	planTriage,
} from '../routing';
import {
	AUTO_SEND_VERDICT_TASKS,
	CALIBRATION_REVISIONS,
	calibrationRevisionFor,
	verdictBlockReason,
	type StoredVerdict,
	type VerdictContext,
} from '../calibration';
import { isLocalDecisionEngine, resolvedPlaneIdentity } from '../configIdentity';

const DEFAULTS = resolveRoutingPolicy(null);
const NOW = Date.UTC(2026, 9, 12);

describe('plans', () => {
	it('plans nothing by default: every switch is off', () => {
		expect(planTriage(DEFAULTS)).toBeNull();
		expect(planMessageBundle(DEFAULTS)).toBeNull();
	});

	it('runs triage in shadow only', () => {
		expect(planTriage({ triageBundle: 'shadow' })).toEqual({ task: 'mail.triage', mode: 'shadow' });
	});

	it.each([
		['off', 'off', null],
		['shadow', 'off', { task: 'mail.category', mode: 'shadow' }],
		['off', 'shadow', { task: 'mail.disposition', mode: 'shadow' }],
		['shadow', 'shadow', { task: 'mail.category', mode: 'shadow' }],
		['enforce', 'off', { task: 'mail.category', mode: 'advisory' }],
		['off', 'enforce', { task: 'mail.disposition', mode: 'advisory' }],
		['shadow', 'enforce', { task: 'mail.disposition', mode: 'advisory' }],
		['enforce', 'shadow', { task: 'mail.category', mode: 'advisory' }],
	] as const)('category %s, disposition %s → one call: %j', (category, disposition, plan) => {
		expect(
			planMessageBundle({ categoryDisplayBundle: category, dispositionAdvisoryBundle: disposition })
		).toEqual(plan);
	});
});

describe('the routing ladder rung', () => {
	it.each([
		[false, 'typesafe', false, 'language'],
		[false, 'typesafe', true, 'language'],
		[true, 'typesafe', false, 'decision'],
		[true, 'local', false, 'decision'],
		[true, 'llm', false, 'language'],
		[true, 'typesafe', true, 'unavailable'],
		[true, 'llm', true, 'unavailable'],
	] as const)('plane on %s, kind %s, unavailable %s → %s', (on, kind, unavailable, rung) => {
		expect(decisionRung({ isDecisionPlaneOn: on, kind, isUnavailable: unavailable })).toBe(rung);
	});
});

describe('artifact keys', () => {
	const base = {
		task: 'mail.category' as const,
		subject: { kind: 'inbound_message' as const, id: 'm1' },
		contentHash: 'h1',
		policyVersion: 3,
		questionSetId: 'mail.message.team',
		questionSetVersion: 1,
	};

	it('changes with every component', () => {
		const key = artifactKeyOf(base);
		expect(artifactKeyOf({ ...base, task: 'mail.disposition' })).not.toBe(key);
		expect(artifactKeyOf({ ...base, subject: { kind: 'inbound_message', id: 'm2' } })).not.toBe(
			key
		);
		expect(artifactKeyOf({ ...base, contentHash: 'h2' })).not.toBe(key);
		expect(artifactKeyOf({ ...base, policyVersion: 4 })).not.toBe(key);
		expect(artifactKeyOf({ ...base, questionSetVersion: 2 })).not.toBe(key);
		expect(artifactKeyOf(base)).toBe(key);
	});
});

describe('the display and advisory projection', () => {
	const artifact = {
		kind: 'advisory' as const,
		status: 'complete',
		expiresAt: NOW + 1,
		labels: { category: 'newsletter', disposition: 'informational' },
	};
	const enforced = {
		categoryDisplayBundle: 'enforce',
		dispositionAdvisoryBundle: 'enforce',
	} as const;

	it('shows each field only under its own enforced switch', () => {
		expect(advisoryProjection(artifact, enforced, NOW)).toEqual({
			category: 'newsletter',
			disposition: 'informational',
		});
		expect(
			advisoryProjection(
				artifact,
				{ categoryDisplayBundle: 'enforce', dispositionAdvisoryBundle: 'shadow' },
				NOW
			)
		).toEqual({ category: 'newsletter' });
		expect(advisoryProjection(artifact, DEFAULTS, NOW)).toEqual({});
	});

	it('shows nothing from a shadow, incomplete, invalidated or expired artifact, or an unknown label', () => {
		expect(advisoryProjection({ ...artifact, kind: 'shadow' }, enforced, NOW)).toEqual({});
		expect(advisoryProjection({ ...artifact, status: 'abstained' }, enforced, NOW)).toEqual({});
		expect(advisoryProjection({ ...artifact, invalidatedAt: NOW }, enforced, NOW)).toEqual({});
		expect(advisoryProjection({ ...artifact, expiresAt: NOW }, enforced, NOW)).toEqual({});
		expect(
			advisoryProjection(
				{ ...artifact, labels: { category: 'unknown', disposition: 'unknown' } },
				enforced,
				NOW
			)
		).toEqual({});
	});
});

describe('the block-only verdict rule', () => {
	const registry = { 'mail.draft_quality': { en: 'baseline-2026-11' } };
	const valid: StoredVerdict = {
		task: 'mail.draft_quality',
		kind: 'advisory',
		status: 'complete',
		policyVersion: 5,
		contextVersion: 'typesafe|jev-1.13.0|',
		expiresAt: NOW + 1000,
		provenance: { provider: 'typesafe' },
		calibration: {
			isAdapterCalibrated: true,
			calibrationRevision: 'baseline-2026-11',
			language: 'en',
		},
	};
	const context: VerdictContext = {
		now: NOW,
		policyVersion: 5,
		decisionConfigIdentity: 'typesafe|jev-1.13.0|',
		language: 'en',
		registry,
	};

	it('lets a complete, current, calibrated verdict through (it never widens anything)', () => {
		expect(verdictBlockReason(valid, context)).toBeNull();
	});

	it.each<[string, Partial<StoredVerdict>, Partial<VerdictContext>, RegExp]>([
		['a shadow observation', { kind: 'shadow' }, {}, /shadow/],
		['an abstention', { status: 'abstained' }, {}, /not complete/],
		['an invalidated verdict', { invalidatedAt: NOW - 1 }, {}, /invalidated/],
		['an expired verdict', { expiresAt: NOW }, {}, /expired/],
		['an older policy', {}, { policyVersion: 6 }, /routing policy/],
		['another provider configured', {}, { decisionConfigIdentity: 'local||' }, /different/],
		['the plane switched off', {}, { decisionConfigIdentity: 'off' }, /different/],
		['an answer from another adapter', { provenance: { provider: 'language' } }, {}, /different/],
		[
			'an uncalibrated adapter',
			{
				calibration: {
					isAdapterCalibrated: false,
					calibrationRevision: 'baseline-2026-11',
					language: 'en',
				},
			},
			{},
			/uncalibrated/,
		],
		['another language', {}, { language: 'de' }, /language/],
		['an unknown message language', {}, { language: undefined }, /language/],
		[
			'a stale calibration revision',
			{
				calibration: {
					isAdapterCalibrated: true,
					calibrationRevision: 'baseline-2026-10',
					language: 'en',
				},
			},
			{},
			/valid calibration/,
		],
		['no registered calibration', {}, { registry: {} }, /valid calibration/],
	])('blocks %s', (_name, verdict, ctx, reason) => {
		expect(verdictBlockReason({ ...valid, ...verdict }, { ...context, ...ctx })).toMatch(reason);
	});

	it('ships with no registered calibration and no verdict feeding auto-send', () => {
		expect(CALIBRATION_REVISIONS).toEqual({});
		expect(AUTO_SEND_VERDICT_TASKS).toEqual([]);
		expect(calibrationRevisionFor('mail.category', 'en')).toBeUndefined();
		expect(verdictBlockReason(valid, { ...context, registry: CALIBRATION_REVISIONS })).toMatch(
			/valid calibration/
		);
	});
});

describe('the decision plane identity and locality', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('is off while the plane is off, and names a provider that cannot answer', () => {
		const plane = { kind: 'typesafe' as const, modelId: 'jev-1.13.0', clientConfig: {} };
		expect(resolvedPlaneIdentity(plane, false)).toBe('off');
		expect(resolvedPlaneIdentity(null, true)).toBe('unavailable');
		expect(resolvedPlaneIdentity({ ...plane, kind: 'llm', degradedFrom: 'typesafe' }, true)).toBe(
			'unavailable:typesafe'
		);
		expect(
			resolvedPlaneIdentity({ ...plane, clientConfig: { baseUrl: 'https://p.example' } }, true)
		).toBe('typesafe|jev-1.13.0|https://p.example');
	});

	it('treats only the local engine as local, from the stored kind or the environment', () => {
		expect(isLocalDecisionEngine({ decisionProviderKind: 'local' }, true)).toBe(true);
		expect(isLocalDecisionEngine({ decisionProviderKind: 'local' }, false)).toBe(false);
		expect(isLocalDecisionEngine({ decisionProviderKind: 'typesafe' }, true)).toBe(false);
		vi.stubEnv('DECISION_PROVIDER', 'local');
		expect(isLocalDecisionEngine(null, true)).toBe(true);
		expect(isLocalDecisionEngine({ decisionProviderKind: 'llm' }, true)).toBe(false);
	});
});
