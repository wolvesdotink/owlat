/**
 * "Migrate from Mailchimp/Mandrill", as data.
 *
 * The guided flow's whole judgement — what each step needs before it may run,
 * what the one-click preset actually writes, and which of the runbook's rules
 * this deployment is currently breaking — lives here as pure functions over the
 * same queries the screen subscribes to. The page renders it; it decides
 * nothing.
 *
 * THE SHAPE THE PRESET WRITES (plan §10, D8). A migration is not a per-stream
 * experiment: the runbook moves the deployment, so all three message types get
 * the same treatment — `adaptive_mix` over `[mta, mandrill]` with Mandrill named
 * as the deliverability-fallback relay — and all three streams get the
 * `conservative` ramp preset. Three `setRoute` writes and three
 * `setStreamPreset` writes, composed on the client and surfaced one by one,
 * rather than a new backend mutation that would duplicate two shipped
 * permission checks and two shipped audit trails.
 *
 * THE ONE RULE THE FLOW POLICES (D8). The alignment machinery wants EXACTLY ONE
 * reference relay. A second enabled relay does not fail the write — it degrades
 * measurement confidence, which holds the ramp at ownShare 0 while looking
 * perfectly healthy — so it is surfaced here as a warning naming the kinds, and
 * `<DeliveryReferenceRelayNotice />` says the same thing from the alignment
 * side.
 */

import {
	eligibleFallbackRelays,
	fallbackRelayIssue,
	type RouteProviderEntry,
} from '~/utils/providerRouting';
import {
	isMandrillProofFresh,
	mandrillOutstanding,
	type MandrillRelayIdentityInput,
} from '~/utils/mandrillRelayStatus';

/** The relay this flow migrates from. */
export const MIGRATION_RELAY_KIND = 'mandrill';

/** Owlat's own arm — the transport the ramp migrates traffic TO. */
export const MIGRATION_OWN_KIND = 'mta';

/**
 * Every message type, in runbook order. A migration covers all three streams:
 * leaving one on a single-transport route would keep part of the deployment on
 * Mandrill with no measurement and no ramp, which is the opposite of the point.
 */
export const MIGRATION_MESSAGE_TYPES = ['transactional', 'campaign', 'automation'] as const;
export type MigrationMessageType = (typeof MIGRATION_MESSAGE_TYPES)[number];

/** Migrations ramp at the cautious pace (plan P4.2). */
export const MIGRATION_RAMP_PRESET = 'conservative';

export const MIGRATION_STEP_IDS = ['connect', 'history', 'domain', 'preset', 'watch'] as const;
export type MigrationStepId = (typeof MIGRATION_STEP_IDS)[number];

export type MigrationStepState = 'complete' | 'current' | 'blocked' | 'upcoming';

// ── Step 1: the key ────────────────────────────────────────────────

export interface MigrationTransportEntry {
	readonly kind: string;
	readonly label: string;
	readonly isAvailable: boolean;
}

/**
 * Whether a transport's credentials are present in the deployment environment.
 * `listTransportCatalog.isAvailable` IS the presence check (`isSendProviderReady`
 * — required env plus grants), and it answers for every kind rather than only
 * for the one `EMAIL_PROVIDER` names, which is what a migration needs: Mandrill
 * is a route member here, not the single transport.
 */
export function isTransportConfigured(
	catalog: readonly MigrationTransportEntry[] | null | undefined,
	kind: string
): boolean {
	return (catalog ?? []).some((entry) => entry.kind === kind && entry.isAvailable);
}

/** The refusal the preset would earn from a missing transport, or null. */
export function migrationTransportIssue(
	catalog: readonly MigrationTransportEntry[] | null | undefined
): string | null {
	if (!isTransportConfigured(catalog, MIGRATION_RELAY_KIND)) {
		return 'Mailchimp Transactional is not connected yet — set MANDRILL_API_KEY and restart the deployment.';
	}
	if (!isTransportConfigured(catalog, MIGRATION_OWN_KIND)) {
		return "Owlat's own MTA is not configured, so there is nothing to migrate traffic onto.";
	}
	return null;
}

// ── Step 3: the sending domain ─────────────────────────────────────

export interface MigrationDomainRow {
	readonly domain: string;
	/** The DNS/ownership items still outstanding, in the order they are worked. */
	readonly outstanding: readonly string[];
	/** True when Mandrill has confirmed this domain and the proof is fresh. */
	readonly isReady: boolean;
}

/**
 * Per-domain readiness for the reference arm.
 *
 * STRICTER THAN THE ROUTING GATE, ON PURPOSE. Routing asks only for a fresh
 * `verified` row with valid SPF and DKIM; this asks for ownership as well,
 * because Mandrill rejects mail from a domain it has not verified
 * (`reject_reason: unsigned`) however good the DNS is. A checklist that called
 * such a domain "done" would send the operator to apply the preset and watch
 * every reference-arm send bounce.
 */
export function migrationDomainRows(
	identities: readonly MandrillRelayIdentityInput[] | null | undefined,
	now: number
): readonly MigrationDomainRow[] {
	return (identities ?? []).map((identity) => {
		const outstanding = mandrillOutstanding(identity);
		return {
			domain: identity.domain,
			outstanding,
			isReady:
				identity.status === 'verified' &&
				isMandrillProofFresh(identity, now) &&
				outstanding.length === 0,
		};
	});
}

/** Whether at least one sending domain can carry reference-arm traffic. */
export function isMigrationDomainReady(
	identities: readonly MandrillRelayIdentityInput[] | null | undefined,
	now: number
): boolean {
	return migrationDomainRows(identities, now).some((row) => row.isReady);
}

// ── D8: exactly one reference relay ────────────────────────────────

export interface MigrationRouteView {
	readonly messageType: string;
	readonly strategy: string;
	readonly providers: readonly RouteProviderEntry[];
}

/**
 * The enabled relay kinds this deployment carries that are NOT the one being
 * migrated from — deduplicated and sorted so the warning reads the same on
 * every render.
 */
export function competingRelayKinds(
	routes: readonly MigrationRouteView[] | null | undefined
): readonly string[] {
	const kinds = new Set<string>();
	for (const route of routes ?? []) {
		for (const relay of eligibleFallbackRelays(route.providers)) {
			if (relay.providerType !== MIGRATION_RELAY_KIND) kinds.add(relay.providerType);
		}
	}
	return [...kinds].sort();
}

/** The D8 warning, or null when Mandrill is already the only relay. */
export function competingRelayWarning(
	routes: readonly MigrationRouteView[] | null | undefined
): string | null {
	const kinds = competingRelayKinds(routes);
	if (kinds.length === 0) return null;
	return `${kinds.join(', ')} ${kinds.length === 1 ? 'is' : 'are'} still enabled alongside Mailchimp Transactional. The measurement plane compares one reference relay against your own MTA, so a second one degrades alignment confidence and the ramp holds at 0% — disable it on the provider-routing screen before applying the preset.`;
}

// ── Step 4: the preset ─────────────────────────────────────────────

export interface MigrationRoutePayload {
	readonly messageType: MigrationMessageType;
	readonly strategy: 'adaptive_mix';
	readonly providers: readonly RouteProviderEntry[];
	readonly deliverabilityFallback: {
		readonly isEnabled: true;
		readonly relayProviderType: string;
		readonly isWarmupOverflowEnabled: false;
	};
}

/**
 * The two route members, enabled exactly as far as the catalog vouches for
 * them. An unconfigured transport is written as disabled rather than omitted, so
 * `fallbackRelayIssue` below refuses with the backend's own sentence instead of
 * the mutation refusing after three-quarters of the preset has landed.
 */
export function migrationRouteProviders(
	catalog: readonly MigrationTransportEntry[] | null | undefined
): readonly RouteProviderEntry[] {
	return [
		{ providerType: MIGRATION_OWN_KIND, isEnabled: isTransportConfigured(catalog, 'mta') },
		{
			providerType: MIGRATION_RELAY_KIND,
			isEnabled: isTransportConfigured(catalog, MIGRATION_RELAY_KIND),
		},
	];
}

/** The three `providerRoutes.setRoute` payloads the preset applies, in order. */
export function migrationRoutePayloads(
	catalog: readonly MigrationTransportEntry[] | null | undefined
): readonly MigrationRoutePayload[] {
	const providers = migrationRouteProviders(catalog);
	return MIGRATION_MESSAGE_TYPES.map((messageType) => ({
		messageType,
		strategy: 'adaptive_mix' as const,
		providers,
		deliverabilityFallback: {
			isEnabled: true as const,
			relayProviderType: MIGRATION_RELAY_KIND,
			// Warm-up overflow spills the own arm's excess onto the relay, which is a
			// SECOND, unmeasured source of reference-arm traffic. During a migration
			// the ramp controller owns the split; leave it off so the share the
			// operator reads on the cells screen is the share that actually sent.
			isWarmupOverflowEnabled: false as const,
		},
	}));
}

/**
 * The refusal the preset would earn, or null when it would save — asked before
 * the first write, in the mutation's own words, so a half-applied preset is not
 * how the operator learns the relay is not connected.
 */
export function migrationPresetIssue(
	catalog: readonly MigrationTransportEntry[] | null | undefined
): string | null {
	const transport = migrationTransportIssue(catalog);
	if (transport !== null) return transport;
	return fallbackRelayIssue(migrationRouteProviders(catalog), MIGRATION_RELAY_KIND);
}

// ── Step 2: what the carry-over actually carried ───────────────────

export interface MigrationSuppressionCounts {
	readonly bouncedHard: number;
	readonly bouncedSoft: number;
	readonly complained: number;
	readonly manual: number;
	readonly unsubscribed: number;
	readonly alreadyBlocked: number;
	readonly alreadyUnsubscribed: number;
	readonly noContact: number;
	readonly skipped: number;
}

export interface MigrationCarriedCount {
	readonly label: string;
	readonly value: number;
}

const CARRIED_LABELS: readonly (readonly [keyof MigrationSuppressionCounts, string])[] = [
	['unsubscribed', 'unsubscribed'],
	['bouncedHard', 'hard bounces'],
	['bouncedSoft', 'soft bounces'],
	['complained', 'spam complaints'],
	['manual', 'manually suppressed'],
	['alreadyBlocked', 'already suppressed here'],
	['alreadyUnsubscribed', 'already unsubscribed here'],
	['noContact', 'no matching contact'],
	['skipped', 'skipped'],
];

/**
 * The carry-over, as the counts worth reading — zeroes dropped.
 *
 * A re-run is a legitimate no-op (every address is idempotent on its lowercased
 * email), so an all-zero second run is not an error and must not read like one:
 * it collapses to an empty list, and the caller says "nothing new to carry".
 */
export function carriedSuppressionCounts(
	counts: MigrationSuppressionCounts | null | undefined
): readonly MigrationCarriedCount[] {
	if (counts === null || counts === undefined) return [];
	return CARRIED_LABELS.filter(([key]) => (counts[key] ?? 0) > 0).map(([key, label]) => ({
		label,
		value: counts[key],
	}));
}

// ── Step assembly ──────────────────────────────────────────────────

export interface MigrationProgressInput {
	readonly isKeyConnected: boolean;
	readonly isHistoryCarried: boolean;
	readonly isDomainReady: boolean;
	readonly isPresetApplied: boolean;
}

export interface MigrationFlowStep {
	readonly id: MigrationStepId;
	readonly title: string;
	readonly summary: string;
	readonly state: MigrationStepState;
	/** Why this step cannot be run yet, or null. */
	readonly blockedBy: string | null;
}

const STEP_COPY: Readonly<Record<MigrationStepId, { title: string; summary: string }>> = {
	connect: {
		title: 'Connect Mailchimp Transactional',
		summary:
			'Owlat sends through your existing Mandrill account first, so day one carries your current reputation, not a cold one.',
	},
	history: {
		title: 'Carry over contacts and suppressions',
		summary:
			'Import the audience, then the unsubscribes and hard bounces Mandrill and Mailchimp accumulated — mailing someone who opted out is how a migration fails on day one.',
	},
	domain: {
		title: 'Verify the sending domain at Mandrill',
		summary:
			'Mandrill rejects mail from a domain it has not verified, so the reference arm cannot carry traffic — and the ramp has nothing to measure against — until this clears.',
	},
	preset: {
		title: 'Apply the migration preset',
		summary:
			'All three message types move to the measured split: 100% Mandrill today, and the ramp controller grows your own MTA’s share cell by cell from there.',
	},
	watch: {
		title: 'Watch the ramp',
		summary:
			'Every decision the controller makes is on the cells screen, in a sentence. Pause, pin or promote any cell at any time.',
	},
};

/**
 * The five steps with their state. `current` is the first incomplete step whose
 * prerequisites are met; a later step whose prerequisites are NOT met reads
 * `blocked` and says why, because "greyed out for a reason you cannot see" is
 * how a guided flow becomes a guessing game.
 */
export function migrationSteps(progress: MigrationProgressInput): readonly MigrationFlowStep[] {
	const complete: Readonly<Record<MigrationStepId, boolean>> = {
		connect: progress.isKeyConnected,
		history: progress.isHistoryCarried,
		domain: progress.isDomainReady,
		preset: progress.isPresetApplied,
		watch: progress.isPresetApplied,
	};
	const blockedBy: Readonly<Record<MigrationStepId, string | null>> = {
		connect: null,
		history: progress.isKeyConnected
			? null
			: 'Connect Mailchimp Transactional first — the reject-list import reads the same key.',
		domain: null,
		preset: !progress.isKeyConnected
			? 'Connect Mailchimp Transactional first.'
			: !progress.isDomainReady
				? 'Finish Mandrill’s domain verification first — the preset would name a relay that cannot send.'
				: null,
		watch: progress.isPresetApplied
			? null
			: 'Apply the preset first — there is no ramp to watch yet.',
	};

	let currentAssigned = false;
	return MIGRATION_STEP_IDS.map((id) => {
		const isComplete = complete[id];
		const blocked = blockedBy[id];
		let state: MigrationStepState;
		if (isComplete) {
			state = 'complete';
		} else if (blocked !== null) {
			state = 'blocked';
		} else if (!currentAssigned) {
			state = 'current';
			currentAssigned = true;
		} else {
			state = 'upcoming';
		}
		return { id, ...STEP_COPY[id], state, blockedBy: blocked };
	});
}

/**
 * Whether the routes already carry the migration shape — the preset step's
 * completion signal, read from the routes themselves rather than remembered in
 * local state, so a reload (or a route changed on the provider-routing screen)
 * tells the truth.
 */
export function isMigrationPresetApplied(
	routes: readonly MigrationRouteView[] | null | undefined
): boolean {
	const byType = new Map((routes ?? []).map((route) => [route.messageType, route]));
	return MIGRATION_MESSAGE_TYPES.every((messageType) => {
		const route = byType.get(messageType);
		if (route === undefined || route.strategy !== 'adaptive_mix') return false;
		const enabled = new Set(route.providers.filter((p) => p.isEnabled).map((p) => p.providerType));
		return enabled.has(MIGRATION_OWN_KIND) && enabled.has(MIGRATION_RELAY_KIND);
	});
}
