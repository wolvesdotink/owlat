/**
 * Feature flag rules: the part of the registry that decides flag STATE.
 *
 * Each core flag's default, its dependencies and whether it is hosted-only are
 * declared here, together with the two functions that turn stored overrides
 * into effective state. `featureFlagDefinitions.ts` builds the full registry
 * from these rules plus each flag's copy, env vars, docker profiles and cascades; both
 * tables are typed over every `CoreFeatureFlagKey`, so neither can hold a flag
 * the other lacks.
 *
 * Kept apart because the web app resolves flags on every page load: this
 * module is in its boot bundle, and must not bring the English copy, the
 * plugin-definition validation or the send-provider catalogs with it. Import
 * from `featureFlags.ts` anywhere else; it re-exports everything here.
 */

export type CoreFeatureFlagKey =
	// Sending
	| 'campaigns'
	| 'campaigns.archive'
	| 'transactional'
	| 'automations'
	// Receiving
	| 'inbox'
	| 'inbox.codeTasks'
	| 'chat'
	| 'postbox'
	| 'postbox.aiDraft'
	| 'postbox.coldPitch'
	| 'mail.external'
	| 'calendar.booking'
	// AI
	| 'ai'
	| 'ai.agent'
	| 'ai.autonomy'
	| 'ai.decisionPlane'
	| 'ai.knowledge'
	| 'ai.knowledge.autoLink'
	| 'ai.knowledge.graphRetrieval'
	| 'ai.knowledge.analytics'
	| 'ai.assistant'
	| 'ai.visualizations'
	// Integrations
	| 'webhooks'
	| 'forms'
	| 'imports.mailchimp'
	| 'imports.stripe'
	| 'imports.mandrill'
	// Security / scanning
	| 'scan.content'
	| 'scan.files'
	| 'scan.urls'
	| 'senderAuthBadges'
	| 'sealedMail'
	// Analytics & deliverability
	| 'analytics.posthog'
	| 'domains.verification'
	| 'domains.dkimRotation'
	// Hosted-mode only (set by control plane, hidden from self-host wizard)
	| 'billing.stripe'
	| 'multiTenancy'
	| 'tier.autoProvision';

/** Runtime flags contributed by statically composed plugins. */
export type PluginFeatureFlagKey = `plugin.${string}`;

export type FeatureFlagKey = CoreFeatureFlagKey | PluginFeatureFlagKey;

/** What resolving a flag's state needs to know about it. */
export interface FeatureFlagRule<Key extends FeatureFlagKey = FeatureFlagKey> {
	readonly key: Key;
	readonly default: boolean;
	/** Other flags that must be ON for this flag to be ON. */
	readonly requires?: readonly FeatureFlagKey[];
	/**
	 * Any-of dependency groups: each inner group is satisfied when at least one
	 * member resolves ON. A flag with an unsatisfied group is forced OFF, exactly
	 * like a missing `requires` dependency. Turning a flag ON never auto-enables
	 * group members (there is no principled choice of which); UIs should disable
	 * the toggle with a "needs one of: …" hint instead.
	 */
	readonly requiresAny?: readonly (readonly FeatureFlagKey[])[];
	/** Hosted-mode-only flag — hidden from the self-host wizard. */
	readonly hostedOnly?: boolean;
}

export const FEATURE_FLAG_RULES: { readonly [Key in CoreFeatureFlagKey]: FeatureFlagRule<Key> } = {
	campaigns: {
		key: 'campaigns',
		default: true,
	},
	'campaigns.archive': {
		key: 'campaigns.archive',
		default: true,
		requires: ['campaigns'],
	},
	transactional: {
		key: 'transactional',
		default: true,
	},
	automations: {
		key: 'automations',
		default: false,
	},

	inbox: {
		key: 'inbox',
		default: false,
	},
	'inbox.codeTasks': {
		key: 'inbox.codeTasks',
		default: false,
		requires: ['inbox', 'ai.agent'],
	},
	chat: {
		key: 'chat',
		default: false,
	},
	postbox: {
		key: 'postbox',
		default: false,
	},
	'postbox.aiDraft': {
		key: 'postbox.aiDraft',
		default: false,
		// Needs the AI master toggle for an LLM provider, plus *a* mailbox source
		// to draft for — either hosted Postbox or a connected external mailbox
		// (`mail.external` deliberately does not require `postbox`; see its
		// comment below). The draft pipeline is source-agnostic, so any-of is the
		// honest dependency. resolveFlags forces this OFF whenever `ai` is off or
		// neither source is on, so a disabled AI stack degrades to today's
		// behaviour.
		requires: ['ai'],
		requiresAny: [['postbox', 'mail.external']],
	},
	'postbox.coldPitch': {
		key: 'postbox.coldPitch',
		default: false,
		// Off until the cold-pitch question passes its labelled sample
		// (`apps/api/scripts/cold-pitch-eval.ts`). Same prerequisites as
		// draft-on-arrival: the AI master toggle and a personal mailbox source.
		requires: ['ai'],
		requiresAny: [['postbox', 'mail.external']],
	},
	'mail.external': {
		key: 'mail.external',
		default: false,
	},
	'calendar.booking': {
		key: 'calendar.booking',
		default: false,
	},

	ai: {
		key: 'ai',
		default: false,
	},
	'ai.agent': {
		key: 'ai.agent',
		default: false,
		requires: ['ai', 'inbox'],
	},
	'ai.autonomy': {
		key: 'ai.autonomy',
		default: false,
		requires: ['ai', 'ai.agent'],
	},
	'ai.decisionPlane': {
		key: 'ai.decisionPlane',
		default: false,
		requires: ['ai'],
	},
	'ai.knowledge': {
		key: 'ai.knowledge',
		default: false,
		requires: ['ai'],
	},
	'ai.knowledge.autoLink': {
		key: 'ai.knowledge.autoLink',
		default: false,
		requires: ['ai.knowledge'],
	},
	'ai.knowledge.graphRetrieval': {
		key: 'ai.knowledge.graphRetrieval',
		default: false,
		requires: ['ai.knowledge'],
	},
	'ai.knowledge.analytics': {
		key: 'ai.knowledge.analytics',
		default: false,
		requires: ['ai.knowledge'],
	},
	'ai.assistant': {
		key: 'ai.assistant',
		default: false,
		requires: ['ai'],
	},
	'ai.visualizations': {
		key: 'ai.visualizations',
		default: false,
		requires: ['ai'],
	},

	webhooks: {
		key: 'webhooks',
		default: false,
	},
	forms: {
		key: 'forms',
		default: true,
	},
	'imports.mailchimp': {
		key: 'imports.mailchimp',
		default: false,
	},
	'imports.stripe': {
		key: 'imports.stripe',
		default: false,
	},
	'imports.mandrill': {
		key: 'imports.mandrill',
		default: false,
	},

	'scan.content': {
		key: 'scan.content',
		default: true,
	},
	'scan.files': {
		key: 'scan.files',
		default: true,
	},
	'scan.urls': {
		key: 'scan.urls',
		default: false,
	},
	senderAuthBadges: {
		key: 'senderAuthBadges',
		// Ships ON by default (Sealed Mail release): resolves on wherever the
		// Postbox plane runs, and stays off on deployments without personal mail.
		default: true,
		// Sender-authenticity surfaces live on the Postbox 1:1 plane.
		requires: ['postbox'],
	},
	sealedMail: {
		key: 'sealedMail',
		// Ships ON by default (Sealed Mail release): auto-seals wherever Postbox +
		// sender authenticity resolve on.
		default: true,
		// End-to-end sealing applies to the Postbox 1:1 plane, and the honest
		// "Sealed - sender verified" badge builds on sender authenticity.
		requires: ['postbox', 'senderAuthBadges'],
	},

	'analytics.posthog': {
		key: 'analytics.posthog',
		default: false,
	},
	'domains.verification': {
		key: 'domains.verification',
		default: true,
	},
	'domains.dkimRotation': {
		key: 'domains.dkimRotation',
		default: true,
	},

	'billing.stripe': {
		key: 'billing.stripe',
		default: false,
		hostedOnly: true,
	},
	multiTenancy: {
		key: 'multiTenancy',
		default: false,
		hostedOnly: true,
	},
	'tier.autoProvision': {
		key: 'tier.autoProvision',
		default: false,
		hostedOnly: true,
	},
};

/** Any registry of rules: the core table, or a full registry with plugin flags. */
export type FeatureFlagRuleRegistry = Readonly<Record<string, FeatureFlagRule>>;

export interface FeatureFlagRuleOptions {
	readonly hosted?: boolean;
	readonly registry?: FeatureFlagRuleRegistry;
}

export type FeatureFlagState = Partial<Record<CoreFeatureFlagKey, boolean>> &
	Record<PluginFeatureFlagKey, boolean>;

/**
 * Default flag state for a fresh self-host install.
 * Hosted-only flags are excluded.
 */
export function getDefaultFlags(opts: FeatureFlagRuleOptions = {}): FeatureFlagState {
	const result: FeatureFlagState = {};
	for (const def of Object.values(opts.registry ?? FEATURE_FLAG_RULES)) {
		if (def.hostedOnly && !opts.hosted) continue;
		result[def.key] = def.default;
	}
	return result;
}

/**
 * Resolve effective flag state by merging stored state with defaults and applying
 * `requires` / `requiresAny` rules. A flag is OFF if any of its dependencies are
 * OFF, or any of its any-of groups has no ON member, regardless of its own
 * stored value.
 */
export function resolveFlags(
	stored: FeatureFlagState,
	opts: FeatureFlagRuleOptions = {}
): Record<FeatureFlagKey, boolean> {
	const registry = opts.registry ?? FEATURE_FLAG_RULES;
	const merged: Record<string, boolean> = { ...getDefaultFlags(opts) };
	for (const definition of Object.values(registry)) {
		if (hasOwnKey(stored, definition.key)) {
			merged[definition.key] = stored[definition.key] === true;
		}
	}

	// Iterate to a fixed point: dependencies can chain (codeTasks → ai.agent → ai + inbox).
	let changed = true;
	let iterations = 0;
	while (changed && iterations < 10) {
		changed = false;
		iterations++;
		for (const def of Object.values(registry)) {
			if (!merged[def.key]) continue;
			for (const dep of def.requires ?? []) {
				if (!merged[dep]) {
					merged[def.key] = false;
					changed = true;
					break;
				}
			}
			if (!merged[def.key]) continue;
			for (const group of def.requiresAny ?? []) {
				if (!group.some((member) => merged[member])) {
					merged[def.key] = false;
					changed = true;
					break;
				}
			}
		}
	}

	return merged as Record<FeatureFlagKey, boolean>;
}

function hasOwnKey(value: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}
