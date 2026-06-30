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

export interface OperatingModePreset {
	key: OperatingModeKey;
	label: string;
	/** Short audience line for the wizard card ("for teams that…"). */
	audience: string;
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
		label: 'CRM only',
		audience: 'Manage contacts and data; no email send or receive.',
		description: 'Contacts, segments, imports, and forms with no outbound or inbound mail. A degenerate baseline you can grow from.',
		flags: { campaigns: false, 'campaigns.archive': false, transactional: false, automations: false },
		needsDeliveryProvider: false,
		needsMta: false,
	},
	imap_only: {
		key: 'imap_only',
		label: 'IMAP-only (read + personal reply)',
		audience: 'Read mail that lives in Google / Fastmail / a company server.',
		description:
			'Connect each user\'s own mailbox over IMAP to read and search mail, and reply 1:1 through their own SMTP. No Owlat delivery provider, no marketing, no transactional API.',
		flags: { campaigns: false, 'campaigns.archive': false, transactional: false, automations: false, 'mail.external': true },
		needsDeliveryProvider: false,
		needsMta: false,
	},
	transactional: {
		key: 'transactional',
		label: 'Transactional API service',
		audience: 'Send receipts, password resets, and other programmatic mail.',
		description: 'The transactional API/SDK over a delivery provider (Resend, SES, or the built-in MTA) with a verified sending domain. No marketing campaigns.',
		flags: { campaigns: false, 'campaigns.archive': false, automations: false, transactional: true },
		needsDeliveryProvider: true,
		needsMta: false,
	},
	marketing: {
		key: 'marketing',
		label: 'Marketing platform',
		audience: 'Run campaigns, automations, and forms to a contact list.',
		description: 'Broadcast campaigns, drip automations, signup forms, and the transactional API over a delivery provider with a verified, authenticated sending domain.',
		flags: { campaigns: true, 'campaigns.archive': true, transactional: true, automations: true },
		needsDeliveryProvider: true,
		needsMta: false,
	},
	hosted_mail: {
		key: 'hosted_mail',
		label: 'Hosted mail server (Postbox)',
		audience: 'Run Owlat as your mail server (Gmail-equivalent).',
		description: 'Per-user mailboxes with webmail + IMAP/SMTP for native clients and MX-based delivery through the built-in MTA. Requires a real domain with MX, SPF, and DKIM.',
		flags: { postbox: true, campaigns: false, 'campaigns.archive': false, transactional: false, automations: false },
		needsDeliveryProvider: false,
		needsMta: true,
	},
	team_inbox: {
		key: 'team_inbox',
		label: 'Team inbox (shared)',
		audience: 'Triage inbound mail as a team in a shared inbox.',
		description: 'A shared inbox that threads inbound conversations and sends replies over a delivery provider. Needs an inbound source (the built-in MTA or a channel webhook).',
		flags: { inbox: true, campaigns: false, 'campaigns.archive': false, automations: false, transactional: true },
		needsDeliveryProvider: true,
		needsMta: true,
	},
	team_inbox_ai: {
		key: 'team_inbox_ai',
		label: 'Team inbox + AI agent',
		audience: 'Shared inbox with AI classification and draft replies.',
		description: 'The shared inbox plus the AI agent (classify inbound mail, draft replies). Requires an LLM provider in addition to a delivery provider and an inbound source.',
		flags: { inbox: true, ai: true, 'ai.agent': true, campaigns: false, 'campaigns.archive': false, automations: false, transactional: true },
		needsDeliveryProvider: true,
		needsMta: true,
	},
	full: {
		key: 'full',
		label: 'Full stack',
		audience: 'Marketing, personal/team mail, and AI all together.',
		description: 'Everything: campaigns, automations, transactional, shared inbox, chat, hosted Postbox, external mailboxes, and the full AI suite.',
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
export function operatingModeFlags(key: OperatingModeKey, opts: { hosted?: boolean } = {}): FeatureFlagState {
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
