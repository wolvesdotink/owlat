/**
 * Core feature flag definitions: every core flag's category, copy, cascades,
 * required env vars and docker profiles, merged with its rule from
 * `featureFlagRuntime.ts` into `FEATURE_FLAGS`.
 *
 * Import from `featureFlags.ts`, which re-exports everything here.
 */

import {
	FEATURE_FLAG_RULES,
	type CoreFeatureFlagKey,
	type FeatureFlagKey,
	type FeatureFlagRule,
	type PluginFeatureFlagKey,
} from './featureFlagRuntime';

export type CoreFeatureCategory =
	| 'sending'
	| 'receiving'
	| 'ai'
	| 'integrations'
	| 'security'
	| 'deliverability'
	| 'hosted';

export type FeatureCategory = CoreFeatureCategory | 'plugins';

/**
 * COPY HERE IS ENGLISH, AND THE WEB UI TRANSLATES IT BY KEY.
 *
 * Unlike `operatingModes.ts` — whose copy is catalog keys, because only the web
 * renders it — these definitions are read outside the browser too: the setup CLI
 * prints `label` as a prompt and `description` as its hint (`owlat-setup setup`,
 * `owlat-setup pack`), and `@owlat/plugin-host` MINTS definitions at runtime for
 * every bundled plugin, whose words no shipped catalog can contain. So the field
 * stays the English sentence and stays the fallback.
 *
 * The web mirrors each core flag/pack under `sharedPkg.featureFlags.*` and
 * resolves it through `useFeatureCopy()` (`apps/web/app/composables/useFeatureCopy.ts`),
 * which falls back to these strings for a plugin flag that has no catalog entry.
 * `apps/web/app/__tests__/sharedRegistryCatalog.test.ts` pins the two copies of
 * the English together, so editing a sentence here without the catalog fails.
 */
interface FeatureFlagDefinitionBase<
	Key extends FeatureFlagKey,
	Category extends FeatureCategory,
> extends FeatureFlagRule<Key> {
	readonly category: Category;
	/** English name; the web renders `sharedPkg.featureFlags.flags.<key>.label`. */
	readonly label: string;
	/** English description; the web renders `sharedPkg.featureFlags.flags.<key>.description`. */
	readonly description: string;
	/** When this flag turns OFF, these flags are also turned OFF. */
	readonly cascadesOff?: readonly FeatureFlagKey[];
	/** Env vars required when this flag is ON (collected by setup CLI/UI). */
	readonly requiredEnvVars?: readonly string[];
	/** Docker compose profile names to enable when this flag is ON. */
	readonly dockerProfiles?: readonly string[];
}

export interface CoreFeatureFlagDefinition extends FeatureFlagDefinitionBase<
	CoreFeatureFlagKey,
	CoreFeatureCategory
> {
	readonly requiredCapabilities?: never;
	readonly pluginPackageName?: never;
}

export interface PluginFeatureFlagDefinition extends FeatureFlagDefinitionBase<
	PluginFeatureFlagKey,
	'plugins'
> {
	/** Capabilities an operator must explicitly grant before enabling this plugin. */
	readonly requiredCapabilities: readonly string[];
	/** Validated package that supplied this plugin flag. */
	readonly pluginPackageName: string;
}

export type FeatureFlagDefinition = CoreFeatureFlagDefinition | PluginFeatureFlagDefinition;

/** Everything about a core flag besides its rule (`featureFlagRuntime.ts`). */
type CoreFeatureFlagDetails = Omit<CoreFeatureFlagDefinition, keyof FeatureFlagRule>;

const FEATURE_FLAG_DETAILS: { readonly [Key in CoreFeatureFlagKey]: CoreFeatureFlagDetails } = {
	campaigns: {
		category: 'sending',
		label: 'Marketing campaigns',
		description: 'Schedule and send broadcast campaigns to contacts and segments.',
	},
	'campaigns.archive': {
		category: 'sending',
		label: 'Public archive links',
		description: 'Publish "View in browser" links for every campaign.',
	},
	transactional: {
		category: 'sending',
		label: 'Transactional API',
		description: 'Send programmatic emails (receipts, password resets) via the API.',
	},
	automations: {
		category: 'sending',
		label: 'Automations',
		description: 'Trigger-based multi-step workflows (welcome series, drip campaigns).',
		// Runs inside the Convex backend (crons + stepWalker) — no extra service.
	},

	inbox: {
		category: 'receiving',
		label: 'Email inbox',
		description: 'Receive inbound mail, thread conversations, and manage a shared inbox.',
		// Inbound email is delivered by the MTA (now an opt-in service), so the
		// shared inbox needs it running to receive mail.
		dockerProfiles: ['mta'],
	},
	// TRUST ASSUMPTION: when on, a feature-request email is turned into an
	// autonomous coding-agent task built from the (attacker-controllable) email
	// body. Only mail from a TRUSTED sender — an org member on this single-org
	// instance — spawns a task; untrusted senders process as normal inbound but
	// never reach the coding agent, and a code-agent-specific appropriateness
	// check rejects destructive/exfiltrating instructions even from members.
	// The trust gate keys on the inbound "From" address, which the Convex ingest
	// stores verbatim (no SPF/DMARC/DKIM-alignment check at this layer), so it
	// ASSUMES inbound sender authentication is enforced upstream (MTA-level DMARC
	// / DKIM alignment). Without that, a From spoofed as a known member passes
	// the allowlist and only the code-agent guard remains as a backstop.
	// See apps/api/convex/codeWorkTasks.ts (createFromInbound) +
	// lib/codeAgentGuard.ts. Default OFF — leave it off unless you trust your
	// org members to drive a coding agent by email.
	'inbox.codeTasks': {
		category: 'receiving',
		label: 'Extract code tasks from inbox',
		description: 'Detect bug reports in inbound mail and surface them as developer tasks.',
		dockerProfiles: ['inbox-codetasks'],
	},
	chat: {
		category: 'receiving',
		label: 'Chat',
		description: 'Real-time chat surface alongside the inbox.',
	},
	postbox: {
		category: 'receiving',
		label: 'Personal mail (Postbox)',
		description:
			'Per-user mailboxes with webmail UI, IMAP/SMTP for native clients, and MX-based delivery (Gmail-equivalent).',
		// personal-mail = the hosted IMAP server + ACME stack; mta = the MX/send
		// transport hosted mailboxes deliver through.
		dockerProfiles: ['personal-mail', 'mta'],
	},
	'postbox.aiDraft': {
		category: 'ai',
		label: 'Draft replies in personal mail',
		description:
			'When a personal message needs a reply, have a draft waiting in the Answer queue. You always review it before it is sent.',
	},
	'postbox.coldPitch': {
		category: 'ai',
		label: 'Hold cold sales pitches out of the Answer queue',
		description:
			'Ask whether mail from a sender you have never written to is an unsolicited sales pitch. A pitch waits in your digest under Cold outreach instead of the Answer queue. It is never marked as spam.',
	},
	'mail.external': {
		category: 'receiving',
		label: 'Connect external mailbox',
		description:
			'Let each user connect their own existing Gmail / Fastmail / company mailbox over IMAP+SMTP — personal mail without registering a sending domain. Independent of hosted Postbox.',
		// Activates the apps/mail-sync worker. Intentionally NOT requires:['postbox']
		// — that would force the hosted ACME + IMAP-server stack (personal-mail
		// profile) the no-domain user is avoiding.
		dockerProfiles: ['external-mail'],
		// The Convex function runtime reaches the worker over these two
		// (mail/mtaClient.ts:getMailSyncConfig). Declared so the gap is REPORTED:
		// flipping this flag on in Settings → Features starts no container and
		// pushes no deployment env, so an instance can sit flag-on/worker-unwired,
		// where connecting a mailbox fails the credential check with "The mail sync
		// service is not configured on this instance." and an external send fails
		// every recipient with EXTERNAL_NOT_CONFIGURED. With them declared, the
		// Features page badges the flag "needs config", and `owlat-setup env --show`
		// / `doctor` name the two missing variables.
		requiredEnvVars: ['MAIL_SYNC_API_URL', 'MAIL_SYNC_API_KEY'],
	},
	// A personal booking page per member (/book/<you>/<meeting>) and "Insert
	// availability" in the composer. Runs inside the Convex backend; the invites
	// go out through the system mail transport, so it needs no mailbox and no
	// extra service.
	'calendar.booking': {
		category: 'receiving',
		label: 'Booking page',
		description:
			'Give each member a public page where people pick a meeting time, and insert your open times into an email.',
	},

	ai: {
		category: 'ai',
		label: 'AI features',
		description: 'Turn on the AI features below. Needs an AI provider.',
		cascadesOff: [
			'ai.agent',
			'ai.autonomy',
			'ai.decisionPlane',
			'ai.knowledge',
			'ai.knowledge.autoLink',
			'ai.knowledge.graphRetrieval',
			'ai.knowledge.analytics',
			'ai.assistant',
			'ai.visualizations',
		],
		requiredEnvVars: ['LLM_PROVIDER', 'LLM_API_KEY'],
		dockerProfiles: ['ai'], // optional local-LLM (ollama) sidecar
	},
	'ai.agent': {
		category: 'ai',
		label: 'Draft replies for me',
		description:
			'Sort incoming team mail by topic and draft a reply to each message, ready for you to review.',
		cascadesOff: ['ai.autonomy', 'inbox.codeTasks'],
	},
	'ai.autonomy': {
		category: 'ai',
		label: 'Rules for each type of message',
		description:
			'Decide per type of message when AI replies may go out without review, and add rules in plain words. Set them up under AI replies.',
	},
	// The kill switch for the decision plane. OFF is not a
	// degraded mode: every decision falls back to the language model the
	// operator already configured, which is byte-for-byte today's behaviour, so
	// an operator can flip this off mid-incident and lose nothing but latency.
	// It is NOT a member of the `ai` feature pack on purpose — one click on a
	// pack must not start sending message content to a provider nobody chose
	// yet. The credential is stored configuration (the AI-providers page), not
	// an env var, so there is nothing to list in `requiredEnvVars`.
	'ai.decisionPlane': {
		category: 'ai',
		label: 'Separate model for quick decisions',
		description:
			'Use a separate decision service for quick calls, such as whether a message needs a reply or which topic it belongs to. Off, your main AI model makes them.',
	},
	'ai.knowledge': {
		category: 'ai',
		label: 'Knowledge graph',
		description: 'Learn facts from your conversations so drafted replies can use them.',
	},
	'ai.knowledge.autoLink': {
		category: 'ai',
		label: 'Connect related facts',
		description:
			'Use AI to spot how saved facts relate to each other, including the ones you already have. Simple links are made either way.',
	},
	'ai.knowledge.graphRetrieval': {
		category: 'ai',
		label: 'Use related facts in drafts',
		description:
			'Find related facts when drafting replies, not only the closest matches. Off, drafts use the closest matches only.',
	},
	'ai.knowledge.analytics': {
		category: 'ai',
		label: 'Knowledge insights',
		description:
			'See which facts matter most and how they group together, on a knowledge dashboard.',
	},
	'ai.assistant': {
		category: 'ai',
		label: 'AI assistant & chat',
		description:
			'An assistant you can chat with, plus @assistant replies inside team chat. It searches your knowledge, files, contacts and campaigns, and drafts copy on request.',
	},
	'ai.visualizations': {
		category: 'ai',
		label: 'AI dashboards',
		description: 'Describe a chart in plain words and get it built from your data.',
	},

	webhooks: {
		category: 'integrations',
		label: 'Outbound webhooks',
		description:
			'Deliver event payloads (campaign sends, contact changes) to external HTTP endpoints.',
		// Outbound webhook delivery runs inside the Convex backend — no service.
	},
	forms: {
		category: 'integrations',
		label: 'Embeddable forms',
		description: 'Generate signup/capture forms to embed on external sites.',
	},
	'imports.mailchimp': {
		category: 'integrations',
		label: 'Mailchimp import',
		description: 'One-click import of contacts and lists from a Mailchimp account.',
	},
	'imports.stripe': {
		category: 'integrations',
		label: 'Stripe customer sync',
		description: 'Sync Stripe customers into Owlat contacts with revenue properties.',
	},
	'imports.mandrill': {
		category: 'integrations',
		label: 'Mandrill suppression import',
		description:
			"Carry a Mandrill account's rejection blacklist (bounces, complaints, unsubscribes) into the suppression list when migrating.",
	},

	'scan.content': {
		category: 'security',
		label: 'Content scanning',
		description: 'Block obvious spam, phishing, and homoglyph attacks before sending.',
	},
	'scan.files': {
		category: 'security',
		label: 'File scanning (ClamAV)',
		description: 'Scan email attachments for malware via a local ClamAV daemon.',
		dockerProfiles: ['clamav'],
	},
	'scan.urls': {
		category: 'security',
		label: 'URL reputation',
		description: 'Check outbound links against Google Safe Browsing before sending.',
		requiredEnvVars: ['GOOGLE_SAFE_BROWSING_API_KEY'],
	},
	senderAuthBadges: {
		category: 'security',
		label: 'Sender authenticity badges',
		description:
			'Show an honest "sender verified" or "not authorized to send for this domain" badge on personal mail, based on the message\'s own authentication result.',
	},
	sealedMail: {
		category: 'security',
		label: 'Sealed mail (end-to-end encryption)',
		description:
			'Encrypt personal mail end-to-end between Owlat instances when every recipient has a usable key, and render a "Sealed" badge for encrypted messages.',
	},

	'analytics.posthog': {
		category: 'deliverability',
		label: 'PostHog analytics',
		description: 'Pipe product events to a PostHog instance for funnel analysis.',
		requiredEnvVars: ['POSTHOG_API_KEY', 'POSTHOG_HOST'],
	},
	'domains.verification': {
		category: 'deliverability',
		label: 'Domain verification',
		description: 'Verify SPF, DKIM, and DMARC records before allowing a domain to send.',
	},
	'domains.dkimRotation': {
		category: 'deliverability',
		label: 'DKIM auto-rotation',
		description:
			'Flag DKIM keys due for rotation and auto-activate an operator-initiated new key once its DNS record is published.',
	},

	'billing.stripe': {
		category: 'hosted',
		label: 'Stripe billing',
		description: 'Charge tenants via Stripe (hosted control plane only).',
		requiredEnvVars: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
	},
	multiTenancy: {
		category: 'hosted',
		label: 'Multi-tenancy',
		description: 'Per-org isolation across VPSes (hosted control plane only).',
	},
	'tier.autoProvision': {
		category: 'hosted',
		label: 'Auto-provisioning',
		description: 'Automatically provision a VPS when a paid subscription starts.',
		requiredEnvVars: ['HETZNER_API_TOKEN'],
	},
};

/** Every core flag: its rule from `FEATURE_FLAG_RULES`, enriched with its details. */
export const FEATURE_FLAGS = Object.fromEntries(
	(Object.keys(FEATURE_FLAG_RULES) as CoreFeatureFlagKey[]).map((key) => [
		key,
		{ ...FEATURE_FLAG_RULES[key], ...FEATURE_FLAG_DETAILS[key] },
	])
) as Record<CoreFeatureFlagKey, CoreFeatureFlagDefinition>;

export const ALL_FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as CoreFeatureFlagKey[];
