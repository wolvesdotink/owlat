/**
 * Who may hear about each kind of marketing notice, behind which feature, and
 * which of the five switches silences it. Pure data and pure predicates (no
 * Convex context), shared by the fan-out, the push sender, the in-app reader
 * and the preferences query so the four can never disagree.
 *
 * Recipients follow the permission that acts on the notice: a finished
 * campaign goes to whoever may manage campaigns, a reminder to whoever may
 * cancel the schedule, and the delivery hold and DNS failure to admins, who are
 * the only ones who can open the delivery pages they link to.
 */

import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { hasPermission, type OrganizationRole, type Permission } from '../lib/sessionOrganization';
import type {
	MarketingNoticeKind,
	MarketingNotificationPreference,
} from '../lib/validators/marketingNotifications';
import { MARKETING_NOTIFICATION_PREFERENCES } from '../lib/validators/marketingNotifications';

interface NoticePolicy {
	preference: MarketingNotificationPreference;
	permission: Permission;
	/** At least one of these must be on. */
	features: readonly FeatureFlagKey[];
}

/** Anything that sends marketing or product mail through the delivery pipeline. */
const SENDING_FEATURES: readonly FeatureFlagKey[] = ['campaigns', 'transactional', 'automations'];

export const MARKETING_NOTICE_POLICY: Record<MarketingNoticeKind, NoticePolicy> = {
	campaign_finished: {
		preference: 'campaignFinished',
		permission: 'campaigns:manage',
		features: ['campaigns'],
	},
	campaign_reminder: {
		preference: 'campaignReminder',
		permission: 'campaigns:schedule',
		features: ['campaigns'],
	},
	delivery_hold: {
		preference: 'deliveryHold',
		permission: 'settings:manage',
		features: SENDING_FEATURES,
	},
	automation_stalled: {
		preference: 'automationProblems',
		permission: 'automations:manage',
		features: ['automations'],
	},
	automation_paused: {
		preference: 'automationProblems',
		permission: 'automations:manage',
		features: ['automations'],
	},
	domain_dns: {
		preference: 'domainDns',
		permission: 'settings:manage',
		features: SENDING_FEATURES,
	},
};

export type ResolvedFlags = Readonly<Record<FeatureFlagKey, boolean>>;

/** The kind's feature is on on this instance. */
export function isNoticeFeatureOn(kind: MarketingNoticeKind, flags: ResolvedFlags): boolean {
	return MARKETING_NOTICE_POLICY[kind].features.some((flag) => flags[flag] === true);
}

/** A member with this role may hear about this kind (and act on it). */
export function isNoticeRoleAllowed(
	kind: MarketingNoticeKind,
	role: OrganizationRole | null | undefined
): boolean {
	return hasPermission(role, MARKETING_NOTICE_POLICY[kind].permission);
}

/** The settings-row field that stores each switch. */
export const PREFERENCE_FIELD = {
	campaignFinished: 'isCampaignFinishedOn',
	campaignReminder: 'isCampaignReminderOn',
	deliveryHold: 'isDeliveryHoldOn',
	automationProblems: 'isAutomationProblemsOn',
	domainDns: 'isDomainDnsOn',
} as const satisfies Record<MarketingNotificationPreference, string>;

/** The switches a person's row holds; an absent row or field means on. */
export type MarketingNotificationSwitches = Partial<
	Record<(typeof PREFERENCE_FIELD)[MarketingNotificationPreference], boolean | undefined>
>;

export function isPreferenceOn(
	row: MarketingNotificationSwitches | null | undefined,
	preference: MarketingNotificationPreference
): boolean {
	return row?.[PREFERENCE_FIELD[preference]] !== false;
}

/** The switches that can ever fire for this role on this instance, in display order. */
export function applicablePreferences(
	role: OrganizationRole | null | undefined,
	flags: ResolvedFlags
): MarketingNotificationPreference[] {
	const kinds = Object.keys(MARKETING_NOTICE_POLICY) as MarketingNoticeKind[];
	const usable = new Set(
		kinds
			.filter((kind) => isNoticeFeatureOn(kind, flags) && isNoticeRoleAllowed(kind, role))
			.map((kind) => MARKETING_NOTICE_POLICY[kind].preference)
	);
	return MARKETING_NOTIFICATION_PREFERENCES.filter((preference) => usable.has(preference));
}
