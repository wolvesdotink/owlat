/**
 * Owlat Feature Flags — single source of truth.
 *
 * Every toggleable product surface is declared here with its default state,
 * required env vars, docker profile, and dependency rules. The setup CLI,
 * web wizard, Convex backend, and Nuxt frontend all read from this file so
 * the toggle list stays in sync across the stack.
 */

export type FeatureFlagKey =
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
	| 'mail.external'
	// AI
	| 'ai'
	| 'ai.agent'
	| 'ai.autonomy'
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
	// Security / scanning
	| 'scan.content'
	| 'scan.files'
	| 'scan.urls'
	// Analytics & deliverability
	| 'analytics.posthog'
	| 'domains.verification'
	| 'domains.dkimRotation'
	// Hosted-mode only (set by control plane, hidden from self-host wizard)
	| 'billing.stripe'
	| 'multiTenancy'
	| 'tier.autoProvision';

export type FeatureCategory =
	| 'sending'
	| 'receiving'
	| 'ai'
	| 'integrations'
	| 'security'
	| 'deliverability'
	| 'hosted';

export interface FeatureFlagDefinition {
	key: FeatureFlagKey;
	category: FeatureCategory;
	label: string;
	description: string;
	default: boolean;
	/** Other flags that must be ON for this flag to be ON. */
	requires?: FeatureFlagKey[];
	/** When this flag turns OFF, these flags are also turned OFF. */
	cascadesOff?: FeatureFlagKey[];
	/** Env vars required when this flag is ON (collected by setup CLI/UI). */
	requiredEnvVars?: string[];
	/** Docker compose profile names to enable when this flag is ON. */
	dockerProfiles?: string[];
	/** Hosted-mode-only flag — hidden from the self-host wizard. */
	hostedOnly?: boolean;
}

export const FEATURE_FLAGS: Record<FeatureFlagKey, FeatureFlagDefinition> = {
	campaigns: {
		key: 'campaigns',
		category: 'sending',
		label: 'Marketing campaigns',
		description: 'Schedule and send broadcast campaigns to contacts and segments.',
		default: true,
	},
	'campaigns.archive': {
		key: 'campaigns.archive',
		category: 'sending',
		label: 'Public archive links',
		description: 'Publish "View in browser" links for every campaign.',
		default: true,
		requires: ['campaigns'],
	},
	transactional: {
		key: 'transactional',
		category: 'sending',
		label: 'Transactional API',
		description: 'Send programmatic emails (receipts, password resets) via the API.',
		default: true,
	},
	automations: {
		key: 'automations',
		category: 'sending',
		label: 'Automations',
		description: 'Trigger-based multi-step workflows (welcome series, drip campaigns).',
		default: false,
		// Runs inside the Convex backend (crons + stepWalker) — no extra service.
	},

	inbox: {
		key: 'inbox',
		category: 'receiving',
		label: 'Email inbox',
		description: 'Receive inbound mail, thread conversations, and manage a shared inbox.',
		default: false,
		// Inbound email is delivered by the MTA (now an opt-in service), so the
		// shared inbox needs it running to receive mail.
		dockerProfiles: ['mta'],
	},
	'inbox.codeTasks': {
		key: 'inbox.codeTasks',
		category: 'receiving',
		label: 'Extract code tasks from inbox',
		description: 'Detect bug reports in inbound mail and surface them as developer tasks.',
		default: false,
		requires: ['inbox', 'ai.agent'],
		dockerProfiles: ['inbox-codetasks'],
	},
	chat: {
		key: 'chat',
		category: 'receiving',
		label: 'Chat',
		description: 'Real-time chat surface alongside the inbox.',
		default: false,
	},
	postbox: {
		key: 'postbox',
		category: 'receiving',
		label: 'Personal mail (Postbox)',
		description: 'Per-user mailboxes with webmail UI, IMAP/SMTP for native clients, and MX-based delivery (Gmail-equivalent).',
		default: false,
		// personal-mail = the hosted IMAP server + ACME stack; mta = the MX/send
		// transport hosted mailboxes deliver through.
		dockerProfiles: ['personal-mail', 'mta'],
	},
	'postbox.aiDraft': {
		key: 'postbox.aiDraft',
		category: 'ai',
		label: 'Draft-on-arrival for personal mail',
		description:
			'Pre-generate a reply draft (with a confidence + quality self-check) into the Reply Queue the moment a personal-mail message that needs a reply lands, so the owner can review-and-send instead of starting from a blank composer. Human review only — never auto-sends.',
		default: false,
		// Needs personal Postbox to have a mailbox to draft for, and the AI master
		// toggle for an LLM provider. resolveFlags forces this OFF whenever either
		// dependency is off, so a disabled AI stack degrades to today's behaviour.
		requires: ['postbox', 'ai'],
	},
	'mail.external': {
		key: 'mail.external',
		category: 'receiving',
		label: 'Connect external mailbox',
		description:
			'Let each user connect their own existing Gmail / Fastmail / company mailbox over IMAP+SMTP — personal mail without registering a sending domain. Independent of hosted Postbox.',
		default: false,
		// Activates the apps/mail-sync worker. Intentionally NOT requires:['postbox']
		// — that would force the hosted ACME + IMAP-server stack (personal-mail
		// profile) the no-domain user is avoiding.
		dockerProfiles: ['external-mail'],
	},

	ai: {
		key: 'ai',
		category: 'ai',
		label: 'AI features',
		description: 'Master toggle for all AI-powered features. Requires an LLM provider.',
		default: false,
		cascadesOff: ['ai.agent', 'ai.autonomy', 'ai.knowledge', 'ai.knowledge.autoLink', 'ai.knowledge.graphRetrieval', 'ai.knowledge.analytics', 'ai.assistant', 'ai.visualizations'],
		requiredEnvVars: ['LLM_PROVIDER', 'LLM_API_KEY'],
		dockerProfiles: ['ai'], // optional local-LLM (ollama) sidecar
	},
	'ai.agent': {
		key: 'ai.agent',
		category: 'ai',
		label: 'AI agent (classify + draft)',
		description: 'Auto-classify inbound mail by intent and draft suggested replies.',
		default: false,
		requires: ['ai', 'inbox'],
		cascadesOff: ['ai.autonomy', 'inbox.codeTasks'],
	},
	'ai.autonomy': {
		key: 'ai.autonomy',
		category: 'ai',
		label: 'Autonomous actions',
		description: 'Let the agent send replies and take actions without human approval when confidence is high.',
		default: false,
		requires: ['ai', 'ai.agent'],
	},
	'ai.knowledge': {
		key: 'ai.knowledge',
		category: 'ai',
		label: 'Knowledge graph',
		description: 'Semantic extraction from conversations to build context for agent drafts.',
		default: false,
		requires: ['ai'],
	},
	'ai.knowledge.autoLink': {
		key: 'ai.knowledge.autoLink',
		category: 'ai',
		label: 'Auto-link knowledge (LLM)',
		description:
			'Infer typed edges between knowledge entries with an LLM pass and backfill existing entries. The deterministic rule-based linker runs whenever the knowledge graph is on; this adds the LLM-inferred edges.',
		default: false,
		requires: ['ai.knowledge'],
	},
	'ai.knowledge.graphRetrieval': {
		key: 'ai.knowledge.graphRetrieval',
		category: 'ai',
		label: 'Graph-augmented retrieval',
		description:
			'Expand semantic-search results along knowledge-graph edges (seed-then-expand) before grounding agent drafts. Kill switch: when off, retrieval is byte-identical to the flat path.',
		default: false,
		requires: ['ai.knowledge'],
	},
	'ai.knowledge.analytics': {
		key: 'ai.knowledge.analytics',
		category: 'ai',
		label: 'Knowledge graph analytics',
		description:
			'Compute graph analytics (centrality, clusters) on a cron and surface a knowledge-graph dashboard.',
		default: false,
		requires: ['ai.knowledge'],
	},
	'ai.assistant': {
		key: 'ai.assistant',
		category: 'ai',
		label: 'AI assistant & chat',
		description:
			'Multi-turn, streaming, tool-calling AI assistant (a dedicated chat surface) plus @assistant replies inside team chat. Searches your knowledge, files, contacts, campaigns, and drafts copy on request.',
		default: false,
		requires: ['ai'],
	},
	'ai.visualizations': {
		key: 'ai.visualizations',
		category: 'ai',
		label: 'AI dashboards',
		description: 'Generate charts and dashboards from natural-language prompts.',
		default: false,
		requires: ['ai'],
	},

	webhooks: {
		key: 'webhooks',
		category: 'integrations',
		label: 'Outbound webhooks',
		description: 'Deliver event payloads (campaign sends, contact changes) to external HTTP endpoints.',
		default: false,
		// Outbound webhook delivery runs inside the Convex backend — no service.
	},
	forms: {
		key: 'forms',
		category: 'integrations',
		label: 'Embeddable forms',
		description: 'Generate signup/capture forms to embed on external sites.',
		default: true,
	},
	'imports.mailchimp': {
		key: 'imports.mailchimp',
		category: 'integrations',
		label: 'Mailchimp import',
		description: 'One-click import of contacts and lists from a Mailchimp account.',
		default: false,
	},
	'imports.stripe': {
		key: 'imports.stripe',
		category: 'integrations',
		label: 'Stripe customer sync',
		description: 'Sync Stripe customers into Owlat contacts with revenue properties.',
		default: false,
	},

	'scan.content': {
		key: 'scan.content',
		category: 'security',
		label: 'Content scanning',
		description: 'Block obvious spam, phishing, and homoglyph attacks before sending.',
		default: true,
	},
	'scan.files': {
		key: 'scan.files',
		category: 'security',
		label: 'File scanning (ClamAV)',
		description: 'Scan email attachments for malware via a local ClamAV daemon.',
		default: true,
		dockerProfiles: ['clamav'],
	},
	'scan.urls': {
		key: 'scan.urls',
		category: 'security',
		label: 'URL reputation',
		description: 'Check outbound links against Google Safe Browsing before sending.',
		default: false,
		requiredEnvVars: ['GOOGLE_SAFE_BROWSING_API_KEY'],
	},

	'analytics.posthog': {
		key: 'analytics.posthog',
		category: 'deliverability',
		label: 'PostHog analytics',
		description: 'Pipe product events to a PostHog instance for funnel analysis.',
		default: false,
		requiredEnvVars: ['POSTHOG_API_KEY', 'POSTHOG_HOST'],
	},
	'domains.verification': {
		key: 'domains.verification',
		category: 'deliverability',
		label: 'Domain verification',
		description: 'Verify SPF, DKIM, and DMARC records before allowing a domain to send.',
		default: true,
	},
	'domains.dkimRotation': {
		key: 'domains.dkimRotation',
		category: 'deliverability',
		label: 'DKIM auto-rotation',
		description: 'Flag DKIM keys due for rotation and auto-activate an operator-initiated new key once its DNS record is published.',
		default: true,
	},

	'billing.stripe': {
		key: 'billing.stripe',
		category: 'hosted',
		label: 'Stripe billing',
		description: 'Charge tenants via Stripe (hosted control plane only).',
		default: false,
		hostedOnly: true,
		requiredEnvVars: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
	},
	multiTenancy: {
		key: 'multiTenancy',
		category: 'hosted',
		label: 'Multi-tenancy',
		description: 'Per-org isolation across VPSes (hosted control plane only).',
		default: false,
		hostedOnly: true,
	},
	'tier.autoProvision': {
		key: 'tier.autoProvision',
		category: 'hosted',
		label: 'Auto-provisioning',
		description: 'Automatically provision a VPS when a paid subscription starts.',
		default: false,
		hostedOnly: true,
		requiredEnvVars: ['HETZNER_API_TOKEN'],
	},
};

export const ALL_FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];

/**
 * Sending-category flags that can only function with a configured delivery
 * provider (`EMAIL_PROVIDER` + creds, or a `providerRoutes` row). These send
 * *bulk* mail through the provider abstraction — unlike `mail.external`, which
 * sends 1:1 personal replies through the user's OWN SMTP and is never a delivery
 * provider. `campaigns.archive` is excluded: it `requires:['campaigns']`, so it
 * can never be the lone reason a provider is needed.
 */
export const SENDING_FLAGS_REQUIRING_DELIVERY = ['campaigns', 'transactional', 'automations'] as const satisfies readonly FeatureFlagKey[];

export type FeatureFlagState = Partial<Record<FeatureFlagKey, boolean>>;

/**
 * Default flag state for a fresh self-host install.
 * Hosted-only flags are excluded.
 */
export function getDefaultFlags(opts: { hosted?: boolean } = {}): FeatureFlagState {
	const result: FeatureFlagState = {};
	for (const def of Object.values(FEATURE_FLAGS)) {
		if (def.hostedOnly && !opts.hosted) continue;
		result[def.key] = def.default;
	}
	return result;
}

/**
 * Resolve effective flag state by merging stored state with defaults and applying
 * `requires` rules. A flag is OFF if any of its dependencies are OFF, regardless
 * of its own stored value.
 */
export function resolveFlags(stored: FeatureFlagState, opts: { hosted?: boolean } = {}): Record<FeatureFlagKey, boolean> {
	const defaults = getDefaultFlags(opts);
	const merged: Record<string, boolean> = { ...defaults, ...stored } as Record<string, boolean>;

	// Iterate to a fixed point: dependencies can chain (codeTasks → ai.agent → ai + inbox).
	let changed = true;
	let iterations = 0;
	while (changed && iterations < 10) {
		changed = false;
		iterations++;
		for (const def of Object.values(FEATURE_FLAGS)) {
			if (!merged[def.key]) continue;
			for (const dep of def.requires ?? []) {
				if (!merged[dep]) {
					merged[def.key] = false;
					changed = true;
					break;
				}
			}
		}
	}

	return merged as Record<FeatureFlagKey, boolean>;
}

/**
 * Returns true if `flag` is enabled given `stored` state, after resolving dependencies.
 */
export function isFlagEnabled(stored: FeatureFlagState, flag: FeatureFlagKey, opts: { hosted?: boolean } = {}): boolean {
	return resolveFlags(stored, opts)[flag];
}

/**
 * Compute the new state after toggling `flag` to `value`, applying cascade rules.
 * Returns the keys that changed (besides `flag` itself) so the UI can surface a confirmation.
 */
export function applyToggle(
	stored: FeatureFlagState,
	flag: FeatureFlagKey,
	value: boolean
): { next: FeatureFlagState; cascaded: FeatureFlagKey[] } {
	const next: FeatureFlagState = { ...stored, [flag]: value };
	const cascaded: FeatureFlagKey[] = [];

	if (!value) {
		// Cascade off: any flag whose `requires` includes this flag must also be off.
		// Plus any explicit `cascadesOff` list.
		const def = FEATURE_FLAGS[flag];
		const queue = new Set<FeatureFlagKey>(def.cascadesOff ?? []);
		for (const other of Object.values(FEATURE_FLAGS)) {
			if (other.requires?.includes(flag)) queue.add(other.key);
		}
		for (const key of queue) {
			if (next[key]) {
				next[key] = false;
				cascaded.push(key);
				// Recurse: turning this one off may cascade further.
				const more = applyToggle(next, key, false);
				Object.assign(next, more.next);
				for (const c of more.cascaded) if (!cascaded.includes(c)) cascaded.push(c);
			}
		}
	} else {
		// Cascade on: any required flag must also be on.
		const def = FEATURE_FLAGS[flag];
		for (const dep of def.requires ?? []) {
			if (!next[dep]) {
				next[dep] = true;
				cascaded.push(dep);
				const more = applyToggle(next, dep, true);
				Object.assign(next, more.next);
				for (const c of more.cascaded) if (!cascaded.includes(c)) cascaded.push(c);
			}
		}
	}

	return { next, cascaded };
}

/**
 * Compute the docker compose profiles to activate for the given flag state.
 * Used by the setup CLI to generate `docker-compose.override.yml`.
 */
export function getActiveProfiles(
	stored: FeatureFlagState,
	opts: { hosted?: boolean; deliveryProvider?: string } = {},
): string[] {
	const resolved = resolveFlags(stored, opts);
	const profiles = new Set<string>();
	for (const def of Object.values(FEATURE_FLAGS)) {
		if (!resolved[def.key]) continue;
		for (const profile of def.dockerProfiles ?? []) profiles.add(profile);
	}
	// The built-in MTA is an opt-in service: it runs only when it is the delivery
	// provider, or when a receiving flag (postbox/inbox) needs it for inbound /
	// hosted send. The receiving cases add the 'mta' profile via their
	// dockerProfiles; the provider case is env-driven, so it is added here.
	if (opts.deliveryProvider === 'mta') profiles.add('mta');
	return Array.from(profiles).sort();
}

/**
 * Compute the union of required env vars for the active flag set.
 * The CLI/wizard uses this to prompt only for env vars actually needed.
 */
export function getRequiredEnvVars(
	stored: FeatureFlagState,
	opts: { hosted?: boolean; deliveryProvider?: string } = {},
): string[] {
	const resolved = resolveFlags(stored, opts);
	const vars = new Set<string>();
	for (const def of Object.values(FEATURE_FLAGS)) {
		if (!resolved[def.key]) continue;
		for (const v of def.requiredEnvVars ?? []) vars.add(v);
	}
	// The bulk send path needs delivery-provider credentials that no single flag
	// can declare statically — the requirement is conditional on which provider
	// `EMAIL_PROVIDER` names. Fold them in when a sending feature is active and
	// the caller knows the provider, so the wizard/doctor model has no hole at
	// the core sending capability.
	if (opts.deliveryProvider && needsDeliveryProvider(stored, opts)) {
		for (const v of getSendPathRequiredEnv(opts.deliveryProvider)) vars.add(v);
	}
	return Array.from(vars).sort();
}

/**
 * True if the resolved flag set includes any sending-category flag that needs a
 * configured delivery provider. Pure and env-blind (it runs in the browser
 * wizard, where it cannot read `.env`): callers pair it with the backend
 * `isDeliveryConfigured` / `deliveryConfiguredFromEnv` to decide whether a
 * provider is actually present. This is the single predicate the wizard,
 * setup-cli, admin UI, and docs share for the "sending needs a provider" rule.
 */
export function needsDeliveryProvider(stored: FeatureFlagState, opts: { hosted?: boolean } = {}): boolean {
	const resolved = resolveFlags(stored, opts);
	return SENDING_FLAGS_REQUIRING_DELIVERY.some((flag) => resolved[flag]);
}

/**
 * The delivery-provider kinds the bulk send path can route through, selected by
 * the `EMAIL_PROVIDER` env var. Kept as a local list so this module stays
 * browser-safe and dependency-free; it mirrors the backend `SendProviderKind`
 * (`apps/api/convex/lib/sendProviders/types.ts`).
 */
export const DELIVERY_PROVIDER_KINDS = ['mta', 'resend', 'ses'] as const;
export type DeliveryProviderKind = (typeof DELIVERY_PROVIDER_KINDS)[number];

/** True iff `value` names a known delivery provider (no implicit MTA default). */
export function isDeliveryProviderKind(value: string | undefined): value is DeliveryProviderKind {
	return value !== undefined && (DELIVERY_PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Runtime env vars a given delivery provider needs before the send path can
 * actually deliver mail. This is the requirements model for the *core sending
 * capability*: the sending feature flags (campaigns/transactional/automations)
 * cannot declare it statically because the need is provider-conditional on
 * `EMAIL_PROVIDER`. The setup wizard prompts for these and `owlat doctor` fails
 * when a sending feature is enabled but they are absent.
 *
 * Mirrors the backend capability check (`providerKindConfigured` in
 * `apps/api/convex/lib/sendProviders/capability.ts`); `ses` additionally needs
 * `AWS_SES_REGION`, which the SES client construction requires. Unknown/unset
 * providers return `[]` — the "is a provider even selected?" question is
 * answered separately by `isDeliveryProviderKind`.
 */
export function getSendPathRequiredEnv(provider: string | undefined): string[] {
	switch (provider) {
		case 'mta':
			return ['MTA_API_URL', 'MTA_API_KEY'];
		case 'resend':
			return ['RESEND_API_KEY'];
		case 'ses':
			return ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'];
		default:
			return [];
	}
}

/**
 * Group flag definitions by category for UI rendering.
 * Hosted-only categories are excluded unless `hosted: true`.
 */
export function getFlagsByCategory(opts: { hosted?: boolean } = {}): Record<FeatureCategory, FeatureFlagDefinition[]> {
	const result: Record<string, FeatureFlagDefinition[]> = {};
	for (const def of Object.values(FEATURE_FLAGS)) {
		if (def.hostedOnly && !opts.hosted) continue;
		(result[def.category] ??= []).push(def);
	}
	return result as Record<FeatureCategory, FeatureFlagDefinition[]>;
}

// ─── Feature packs ────────────────────────────────────────────────────────────
//
// A FeaturePack is a UI grouping over atomic flags so users can toggle a whole
// product surface (e.g. "Email Client") in one click. Packs do not introduce
// new state — they read and write the same `FeatureFlagState`, reusing the
// existing `applyToggle` cascade.

export type FeaturePackKey = 'emailClient' | 'marketing' | 'ai';

export interface FeaturePack {
	key: FeaturePackKey;
	label: string;
	description: string;
	flags: FeatureFlagKey[];
}

export const FEATURE_PACKS: Record<FeaturePackKey, FeaturePack> = {
	emailClient: {
		key: 'emailClient',
		label: 'Email Client',
		description: 'Inbox, chat, and personal mail (Postbox) as one bundle.',
		flags: ['inbox', 'chat', 'postbox'],
	},
	marketing: {
		key: 'marketing',
		label: 'Marketing',
		description: 'Campaigns, automations, and the transactional API.',
		flags: ['campaigns', 'automations', 'transactional'],
	},
	ai: {
		key: 'ai',
		label: 'AI',
		description: 'AI agent, autonomy, knowledge graph (+ auto-link, graph retrieval, analytics), assistant, and dashboards.',
		flags: ['ai', 'ai.agent', 'ai.autonomy', 'ai.knowledge', 'ai.knowledge.autoLink', 'ai.knowledge.graphRetrieval', 'ai.knowledge.analytics', 'ai.assistant', 'ai.visualizations'],
	},
};

export const ALL_FEATURE_PACK_KEYS = Object.keys(FEATURE_PACKS) as FeaturePackKey[];

export type PackState = 'on' | 'off' | 'partial';

/**
 * Returns 'on' if every flag in the pack is enabled, 'off' if every flag is
 * disabled, or 'partial' otherwise. Resolves flags through `resolveFlags`
 * so dependency cascades are honored.
 */
export function isPackEnabled(
	stored: FeatureFlagState,
	packKey: FeaturePackKey,
	opts: { hosted?: boolean } = {}
): PackState {
	const pack = FEATURE_PACKS[packKey];
	const resolved = resolveFlags(stored, opts);
	let on = 0;
	let off = 0;
	for (const flag of pack.flags) {
		if (resolved[flag]) on++;
		else off++;
	}
	if (on === pack.flags.length) return 'on';
	if (off === pack.flags.length) return 'off';
	return 'partial';
}

/**
 * Toggle every flag in the pack to `value`, reusing `applyToggle` for each so
 * cascade rules apply. Returns the final state and the union of cascaded
 * sibling flags (excluding the pack members themselves).
 */
export function applyPackToggle(
	stored: FeatureFlagState,
	packKey: FeaturePackKey,
	value: boolean
): { next: FeatureFlagState; cascaded: FeatureFlagKey[] } {
	const pack = FEATURE_PACKS[packKey];
	let next: FeatureFlagState = { ...stored };
	const cascaded = new Set<FeatureFlagKey>();
	for (const flag of pack.flags) {
		const result = applyToggle(next, flag, value);
		next = result.next;
		for (const c of result.cascaded) {
			if (!pack.flags.includes(c)) cascaded.add(c);
		}
	}
	return { next, cascaded: Array.from(cascaded) };
}
