/**
 * The migration flow's judgement, without a DOM: what each step needs, what the
 * preset writes, and the one rule (D8) the flow polices.
 */
import { describe, expect, it } from 'vitest';
import {
	carriedSuppressionCounts,
	competingRelayKinds,
	competingRelayWarning,
	isMigrationDomainReady,
	isMigrationPresetApplied,
	isTransportConfigured,
	MIGRATION_MESSAGE_TYPES,
	MIGRATION_RAMP_PRESET,
	migrationDomainRows,
	migrationPresetIssue,
	migrationRoutePayloads,
	migrationSteps,
	migrationTransportIssue,
	type MigrationMessage,
	type MigrationRouteView,
	type MigrationSuppressionCounts,
	type MigrationTransportEntry,
} from '../mandrillMigration';
import type { MandrillRelayIdentityInput } from '../mandrillRelayStatus';
import { createTestI18n } from '~/__tests__/i18n';

// The flow is a pure derivation, so every sentence it hands back arrives as a
// message key (the competing relays as its interpolation); the copy an operator
// reads is resolved through the real catalog.
const { t } = createTestI18n().global;
const say = (value: MigrationMessage | null) =>
	value === null ? null : typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

const WEEK = 7 * 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function catalog(over: Partial<Record<string, boolean>> = {}): MigrationTransportEntry[] {
	const availability: Record<string, boolean> = { mta: true, mandrill: true, ses: false, ...over };
	return Object.entries(availability).map(([kind, isAvailable]) => ({
		kind,
		label: kind,
		isAvailable,
	}));
}

function identity(over: Partial<MandrillRelayIdentityInput> = {}): MandrillRelayIdentityInput {
	return {
		domain: 'example.com',
		status: 'verified',
		spf: { isValid: true },
		dkim: { isValid: true },
		verifiedAt: NOW - 1000,
		lastError: null,
		lastCheckedAt: NOW - 1000,
		nextCheckDueAt: NOW + 60_000,
		proofMaxAgeMs: WEEK,
		...over,
	};
}

function route(over: Partial<MigrationRouteView> = {}): MigrationRouteView {
	return {
		messageType: 'campaign',
		strategy: 'adaptive_mix',
		providers: [
			{ providerType: 'mta', isEnabled: true },
			{ providerType: 'mandrill', isEnabled: true },
		],
		...over,
	};
}

describe('step 1 — the key is a presence check, per kind', () => {
	it('reads Mandrill from the catalog rather than from EMAIL_PROVIDER', () => {
		expect(isTransportConfigured(catalog(), 'mandrill')).toBe(true);
		expect(isTransportConfigured(catalog({ mandrill: false }), 'mandrill')).toBe(false);
		expect(isTransportConfigured(null, 'mandrill')).toBe(false);
	});

	it('names the missing side, and the MTA is a side too', () => {
		expect(migrationTransportIssue(catalog())).toBeNull();
		expect(say(migrationTransportIssue(catalog({ mandrill: false })))).toContain(
			'MANDRILL_API_KEY'
		);
		expect(say(migrationTransportIssue(catalog({ mta: false })))).toContain('nothing to migrate');
	});
});

describe('step 3 — the domain checklist is stricter than the routing gate', () => {
	it('is ready only when verified, fresh AND owned', () => {
		expect(isMigrationDomainReady([identity()], NOW)).toBe(true);
		// Routing would accept this row's SPF/DKIM, but Mandrill rejects mail from
		// a domain it has not verified (`unsigned`), so the checklist does not.
		expect(isMigrationDomainReady([identity({ verifiedAt: null })], NOW)).toBe(false);
		expect(isMigrationDomainReady([identity({ status: 'pending_dns' })], NOW)).toBe(false);
		expect(isMigrationDomainReady([], NOW)).toBe(false);
	});

	it('treats a proof older than the routing bound as not ready', () => {
		const stale = identity({ lastCheckedAt: NOW - WEEK - 1 });
		expect(isMigrationDomainReady([stale], NOW)).toBe(false);
	});

	it('lists the outstanding items in the order they are worked', () => {
		const rows = migrationDomainRows(
			[identity({ spf: { isValid: false }, dkim: { isValid: false }, verifiedAt: null })],
			NOW
		);
		expect(rows[0]?.outstanding.map((key) => t(key))).toEqual(['SPF', 'DKIM', 'domain ownership']);
		expect(rows[0]?.isReady).toBe(false);
	});

	it('is ready when ONE of several domains is', () => {
		expect(
			isMigrationDomainReady([identity({ domain: 'a.test', status: 'failed' }), identity()], NOW)
		).toBe(true);
	});
});

describe('D8 — exactly one reference relay', () => {
	it('says nothing when Mandrill is the only relay', () => {
		expect(competingRelayKinds([route()])).toEqual([]);
		expect(competingRelayWarning([route()])).toBeNull();
	});

	it('names every other enabled relay, deduplicated and sorted', () => {
		const routes = [
			route({
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'ses', isEnabled: true },
					{ providerType: 'mandrill', isEnabled: true },
				],
			}),
			route({
				messageType: 'transactional',
				providers: [
					{ providerType: 'resend', isEnabled: true },
					{ providerType: 'ses', isEnabled: true },
				],
			}),
		];
		expect(competingRelayKinds(routes)).toEqual(['resend', 'ses']);
		const warning = say(competingRelayWarning(routes));
		expect(warning).toContain('resend, ses');
		expect(warning).toContain('are still enabled');
		expect(warning).toContain('holds at 0%');
	});

	it('ignores a disabled relay and never counts the own MTA', () => {
		const routes = [
			route({
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'ses', isEnabled: false },
					{ providerType: 'mandrill', isEnabled: true },
				],
			}),
		];
		expect(competingRelayKinds(routes)).toEqual([]);
	});
});

describe('step 4 — the preset shape', () => {
	it('covers all three message types with adaptive_mix over [mta, mandrill]', () => {
		const payloads = migrationRoutePayloads(catalog());
		expect(payloads.map((p) => p.messageType)).toEqual([...MIGRATION_MESSAGE_TYPES]);
		for (const payload of payloads) {
			expect(payload.strategy).toBe('adaptive_mix');
			expect(payload.providers).toEqual([
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'mandrill', isEnabled: true },
			]);
			expect(payload.deliverabilityFallback).toEqual({
				isEnabled: true,
				relayProviderType: 'mandrill',
				// The controller owns the split during a migration; overflow would be
				// a second, unmeasured source of reference-arm traffic.
				isWarmupOverflowEnabled: false,
			});
		}
	});

	it('ramps migrations at the conservative pace', () => {
		expect(MIGRATION_RAMP_PRESET).toBe('conservative');
	});

	it('pre-flights with the mutation’s own refusal sentence', () => {
		expect(migrationPresetIssue(catalog())).toBeNull();
		// An unconfigured relay is written as disabled, which is exactly the state
		// `setRoute` refuses — and it refuses in these words.
		expect(say(migrationPresetIssue(catalog({ mandrill: false })))).toContain('MANDRILL_API_KEY');
		const noMta = migrationRoutePayloads(catalog({ mta: false }))[0];
		expect(noMta?.providers[0]).toEqual({ providerType: 'mta', isEnabled: false });
	});

	it('reads applied-ness off the routes, not off a local flag', () => {
		const applied = MIGRATION_MESSAGE_TYPES.map((messageType) => route({ messageType }));
		expect(isMigrationPresetApplied(applied)).toBe(true);
		expect(isMigrationPresetApplied(applied.slice(0, 2))).toBe(false);
		expect(
			isMigrationPresetApplied(
				applied.map((r) => (r.messageType === 'automation' ? { ...r, strategy: 'single' } : r))
			)
		).toBe(false);
		expect(isMigrationPresetApplied(null)).toBe(false);
	});
});

describe('the step ladder', () => {
	const nothingDone = {
		isKeyConnected: false,
		isHistoryCarried: false,
		isDomainReady: false,
		isPresetApplied: false,
	};

	it('makes connect the current step and blocks what depends on it', () => {
		const steps = migrationSteps(nothingDone);
		const byId = new Map(steps.map((step) => [step.id, step]));
		expect(byId.get('connect')?.state).toBe('current');
		expect(byId.get('history')?.state).toBe('blocked');
		expect(say(byId.get('history')?.blockedBy ?? null)).toContain(
			'Connect Mailchimp Transactional first'
		);
		expect(byId.get('preset')?.state).toBe('blocked');
		expect(byId.get('watch')?.state).toBe('blocked');
	});

	it('will not let the preset run while the relay domain is unverified', () => {
		const steps = migrationSteps({ ...nothingDone, isKeyConnected: true, isHistoryCarried: true });
		const preset = steps.find((step) => step.id === 'preset');
		expect(preset?.state).toBe('blocked');
		expect(say(preset?.blockedBy ?? null)).toContain('domain verification');
	});

	it('opens the preset once the key and the domain are in place', () => {
		const steps = migrationSteps({
			isKeyConnected: true,
			isHistoryCarried: true,
			isDomainReady: true,
			isPresetApplied: false,
		});
		const byId = new Map(steps.map((step) => [step.id, step]));
		expect(byId.get('connect')?.state).toBe('complete');
		expect(byId.get('domain')?.state).toBe('complete');
		expect(byId.get('preset')?.state).toBe('current');
		expect(byId.get('preset')?.blockedBy).toBeNull();
	});

	it('completes the flow, and watching is only unlocked by the preset', () => {
		const steps = migrationSteps({
			isKeyConnected: true,
			isHistoryCarried: true,
			isDomainReady: true,
			isPresetApplied: true,
		});
		expect(steps.every((step) => step.state === 'complete')).toBe(true);
	});

	it('lets the domain step be worked out of order', () => {
		// Publishing DNS while an import runs is normal; the domain step never
		// waits on the carry-over.
		const steps = migrationSteps({ ...nothingDone, isKeyConnected: true });
		expect(steps.find((step) => step.id === 'domain')?.blockedBy).toBeNull();
	});
});

describe('what the carry-over carried', () => {
	const counts: MigrationSuppressionCounts = {
		bouncedHard: 12,
		bouncedSoft: 0,
		complained: 3,
		manual: 0,
		unsubscribed: 400,
		alreadyBlocked: 7,
		alreadyUnsubscribed: 0,
		noContact: 0,
		skipped: 0,
	};

	it('drops the zeroes and leads with unsubscribes', () => {
		expect(
			carriedSuppressionCounts(counts).map((entry) => ({ ...entry, label: t(entry.label) }))
		).toEqual([
			{ label: 'unsubscribed', value: 400 },
			{ label: 'hard bounces', value: 12 },
			{ label: 'spam complaints', value: 3 },
			{ label: 'already suppressed here', value: 7 },
		]);
	});

	it('reads an idempotent re-run as an empty list, not as an error', () => {
		const rerun = Object.fromEntries(
			Object.keys(counts).map((key) => [key, 0])
		) as unknown as MigrationSuppressionCounts;
		expect(carriedSuppressionCounts(rerun)).toEqual([]);
		expect(carriedSuppressionCounts(null)).toEqual([]);
	});
});
