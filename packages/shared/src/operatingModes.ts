/**
 * Owlat operating modes — named presets over the feature-flag graph.
 *
 * A company can run Owlat in several distinct shapes (read-only IMAP client,
 * transactional API service, marketing platform, hosted mail server, team
 * inbox + AI, full stack). Each "mode" is just a posture of the atomic flags in
 * `featureFlags.ts`; this module names the common ones so the setup wizard can
 * offer a one-click choice and the docs can describe a single canonical set.
 *
 * Presets do NOT introduce new state — they resolve to a `FeatureFlagState`
 * through the same `resolveFlags` cascade every other consumer uses. The hard
 * "sending needs a delivery provider" invariant is enforced by
 * `needsDeliveryProvider` + the backend capability check, independent of which
 * preset (if any) a user started from.
 */

import { type FeatureFlagState, getDefaultFlags, resolveFlags } from './featureFlags';

export type OperatingModeKey =
	| 'crm_only'
	| 'imap_only'
	| 'transactional'
	| 'marketing'
	| 'hosted_mail'
	| 'team_inbox'
	| 'team_inbox_ai'
	| 'full';

/**
 * COPY HERE IS MESSAGE KEYS, NOT SENTENCES.
 *
 * This registry is built at module scope and has no component instance, so it
 * cannot call `t()`. Every consumer of `label`/`audience`/`description` is a web
 * surface (the setup wizard's mode step and Settings → Instance), so the three
 * carry `sharedPkg.operatingModes.<key>.*` catalog keys and whoever renders them
 * turns them into words. Unlike `featureFlags.ts` — whose labels the setup CLI
 * prints to a terminal — no backend reads these, so nothing needs the English.
 */
export interface OperatingModePreset {
	key: OperatingModeKey;
	/** Catalog key for the mode's name. */
	label: string;
	/** Catalog key for the short audience line on the wizard card ("for teams that…"). */
	audience: string;
	/** Catalog key for the mode's full description. */
	description: string;
	/**
	 * Flag overrides applied on top of `getDefaultFlags()`. Only the flags this
	 * mode actively manages are listed; everything else keeps its default.
	 */
	flags: FeatureFlagState;
	/**
	 * Whether this mode sends BULK mail (campaigns/transactional/automations) and
	 * therefore requires a configured delivery provider. Kept in sync with
	 * `needsDeliveryProvider(operatingModeFlags(key))` by a unit test.
	 */
	needsDeliveryProvider: boolean;
	/**
	 * Whether this mode needs the built-in MTA specifically (hosted mailboxes /
	 * inbound MX), beyond the generic bulk-delivery requirement. Drives whether
	 * the wizard should still ask for a transport even when no bulk flag is on.
	 */
	needsMta: boolean;
}

export const OPERATING_MODES: Record<OperatingModeKey, OperatingModePreset> = {
	crm_only: {
		key: 'crm_only',
		label: 'sharedPkg.operatingModes.crm_only.label',
		audience: 'sharedPkg.operatingModes.crm_only.audience',
		description: 'sharedPkg.operatingModes.crm_only.description',
		flags: {
			campaigns: false,
			'campaigns.archive': false,
			transactional: false,
			automations: false,
		},
		needsDeliveryProvider: false,
		needsMta: false,
	},
	imap_only: {
		key: 'imap_only',
		label: 'sharedPkg.operatingModes.imap_only.label',
		audience: 'sharedPkg.operatingModes.imap_only.audience',
		description: 'sharedPkg.operatingModes.imap_only.description',
		flags: {
			campaigns: false,
			'campaigns.archive': false,
			transactional: false,
			automations: false,
			'mail.external': true,
		},
		needsDeliveryProvider: false,
		needsMta: false,
	},
	transactional: {
		key: 'transactional',
		label: 'sharedPkg.operatingModes.transactional.label',
		audience: 'sharedPkg.operatingModes.transactional.audience',
		description: 'sharedPkg.operatingModes.transactional.description',
		flags: {
			campaigns: false,
			'campaigns.archive': false,
			automations: false,
			transactional: true,
		},
		needsDeliveryProvider: true,
		needsMta: false,
	},
	marketing: {
		key: 'marketing',
		label: 'sharedPkg.operatingModes.marketing.label',
		audience: 'sharedPkg.operatingModes.marketing.audience',
		description: 'sharedPkg.operatingModes.marketing.description',
		flags: { campaigns: true, 'campaigns.archive': true, transactional: true, automations: true },
		needsDeliveryProvider: true,
		needsMta: false,
	},
	hosted_mail: {
		key: 'hosted_mail',
		label: 'sharedPkg.operatingModes.hosted_mail.label',
		audience: 'sharedPkg.operatingModes.hosted_mail.audience',
		description: 'sharedPkg.operatingModes.hosted_mail.description',
		flags: {
			postbox: true,
			campaigns: false,
			'campaigns.archive': false,
			transactional: false,
			automations: false,
		},
		needsDeliveryProvider: false,
		needsMta: true,
	},
	team_inbox: {
		key: 'team_inbox',
		label: 'sharedPkg.operatingModes.team_inbox.label',
		audience: 'sharedPkg.operatingModes.team_inbox.audience',
		description: 'sharedPkg.operatingModes.team_inbox.description',
		flags: {
			inbox: true,
			campaigns: false,
			'campaigns.archive': false,
			automations: false,
			transactional: true,
		},
		needsDeliveryProvider: true,
		needsMta: true,
	},
	team_inbox_ai: {
		key: 'team_inbox_ai',
		label: 'sharedPkg.operatingModes.team_inbox_ai.label',
		audience: 'sharedPkg.operatingModes.team_inbox_ai.audience',
		description: 'sharedPkg.operatingModes.team_inbox_ai.description',
		flags: {
			inbox: true,
			ai: true,
			'ai.agent': true,
			campaigns: false,
			'campaigns.archive': false,
			automations: false,
			transactional: true,
		},
		needsDeliveryProvider: true,
		needsMta: true,
	},
	full: {
		key: 'full',
		label: 'sharedPkg.operatingModes.full.label',
		audience: 'sharedPkg.operatingModes.full.audience',
		description: 'sharedPkg.operatingModes.full.description',
		flags: {
			campaigns: true,
			'campaigns.archive': true,
			transactional: true,
			automations: true,
			inbox: true,
			chat: true,
			postbox: true,
			'mail.external': true,
			ai: true,
			'ai.agent': true,
			'ai.knowledge': true,
			'ai.assistant': true,
		},
		needsDeliveryProvider: true,
		needsMta: true,
	},
};

export const OPERATING_MODE_KEYS = Object.keys(OPERATING_MODES) as OperatingModeKey[];

/**
 * Resolve a mode preset to a concrete, dependency-consistent `FeatureFlagState`
 * (defaults overlaid with the preset's managed flags, then run through the
 * `resolveFlags` cascade so e.g. `campaigns.archive` drops when `campaigns` is off).
 */
export function operatingModeFlags(
	key: OperatingModeKey,
	opts: { hosted?: boolean } = {}
): FeatureFlagState {
	const preset = OPERATING_MODES[key];
	return resolveFlags({ ...getDefaultFlags(opts), ...preset.flags }, opts);
}

/**
 * Whether the wizard must collect an email transport for this mode — either
 * because it sends bulk mail (`needsDeliveryProvider`) or because it relies on
 * the built-in MTA for hosted mailboxes / inbound (`needsMta`).
 */
export function operatingModeNeedsTransport(key: OperatingModeKey): boolean {
	const preset = OPERATING_MODES[key];
	return preset.needsDeliveryProvider || preset.needsMta;
}
