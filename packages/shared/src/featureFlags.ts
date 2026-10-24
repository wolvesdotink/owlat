/**
 * Owlat Feature Flags — single source of truth.
 *
 * Every toggleable product surface is declared here with its required env
 * vars, docker profile and copy, and in `featureFlagRuntime.ts` with its
 * default state and dependency rules. The setup CLI, web wizard, Convex
 * backend, and Nuxt frontend all read from this file so the toggle list stays
 * in sync across the stack.
 */

import {
	capturePluginDefinitionArray,
	INVALID_PLUGIN_FEATURE_FLAG_DEFINITION,
	isPluginFeatureFlagDefinition,
	MAX_PLUGIN_FEATURE_FLAGS,
	snapshotPluginFeatureFlagDefinition,
} from './pluginFeatureFlagDefinition';
import {
	coreSendProviderCatalogEntry,
	isCoreSendProviderKind,
	isOwnSendProviderKind,
	SEND_TRANSPORT_KINDS,
	type CoreSendProviderKind,
} from './sendProviderCatalog';
import {
	FEATURE_FLAG_RULES,
	resolveFlags,
	type CoreFeatureFlagKey,
	type FeatureFlagKey,
	type FeatureFlagRule,
	type FeatureFlagState,
	type PluginFeatureFlagKey,
} from './featureFlagRuntime';

export { isPluginFeatureFlagDefinition };
export { isPluginFeatureFlagKey } from './pluginFeatureFlagDefinition';
export {
	getDefaultFlags,
	resolveFlags,
	type CoreFeatureFlagKey,
	type FeatureFlagKey,
	type FeatureFlagState,
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

export type FeatureFlagRegistry = Readonly<Record<string, FeatureFlagDefinition>>;

/**
 * Merge build-time plugin definitions into the core registry. The generated
 * composition is already validated, but this shared boundary still rejects a
 * malformed, duplicate, or dangling definition before any runtime resolves it.
 */
export function createFeatureFlagRegistry(
	pluginDefinitions: readonly PluginFeatureFlagDefinition[] = []
): FeatureFlagRegistry {
	const definitions = capturePluginDefinitionArray(pluginDefinitions);
	if (definitions.kind !== 'valid') {
		if (definitions.kind === 'too_many') {
			throw new TypeError(
				`At most ${MAX_PLUGIN_FEATURE_FLAGS} plugin feature flags may be registered`
			);
		}
		throw new TypeError(INVALID_PLUGIN_FEATURE_FLAG_DEFINITION);
	}

	const registry = Object.assign(
		Object.create(null) as Record<string, FeatureFlagDefinition>,
		FEATURE_FLAGS
	);
	for (const untrustedDefinition of definitions.value) {
		const definition = snapshotPluginFeatureFlagDefinition(untrustedDefinition);
		if (!definition) {
			throw new TypeError(INVALID_PLUGIN_FEATURE_FLAG_DEFINITION);
		}
		if (hasFeatureFlagDefinition(registry, definition.key)) {
			throw new TypeError(`Duplicate feature flag definition: ${definition.key}`);
		}
		registry[definition.key] = definition;
	}

	for (const definition of Object.values(registry)) {
		for (const dependency of definition.requires ?? []) {
			if (!hasFeatureFlagDefinition(registry, dependency)) {
				throw new TypeError(`${definition.key} requires unknown feature flag ${dependency}`);
			}
		}
		for (const cascadeTarget of definition.cascadesOff ?? []) {
			if (!hasFeatureFlagDefinition(registry, cascadeTarget)) {
				throw new TypeError(`${definition.key} cascades to unknown feature flag ${cascadeTarget}`);
			}
		}
		for (const group of definition.requiresAny ?? []) {
			// An empty group can never be satisfied — the flag would be permanently
			// forced off, which is a declaration bug, not a state.
			if (group.length === 0) {
				throw new TypeError(`${definition.key} declares an empty requiresAny group`);
			}
			for (const member of group) {
				if (!hasFeatureFlagDefinition(registry, member)) {
					throw new TypeError(`${definition.key} requiresAny unknown feature flag ${member}`);
				}
			}
		}
	}

	return Object.freeze(registry);
}

export function hasFeatureFlagDefinition(registry: FeatureFlagRegistry, key: string): boolean {
	return hasOwnKey(registry, key);
}

export function getFeatureFlagDefinition(
	registry: FeatureFlagRegistry,
	key: string
): FeatureFlagDefinition | undefined {
	return hasFeatureFlagDefinition(registry, key) ? registry[key] : undefined;
}

export interface FeatureFlagResolutionOptions {
	readonly hosted?: boolean;
	readonly registry?: FeatureFlagRegistry;
}

/**
 * Sending-category flags that can only function with a configured delivery
 * provider (`EMAIL_PROVIDER` + creds, or a `providerRoutes` row). These send
 * *bulk* mail through the provider abstraction — unlike `mail.external`, which
 * sends 1:1 personal replies through the user's OWN SMTP and is never a delivery
 * provider. `campaigns.archive` is excluded: it `requires:['campaigns']`, so it
 * can never be the lone reason a provider is needed.
 */
export const SENDING_FLAGS_REQUIRING_DELIVERY = [
	'campaigns',
	'transactional',
	'automations',
] as const satisfies readonly FeatureFlagKey[];

/**
 * Returns true if `flag` is enabled given `stored` state, after resolving dependencies.
 */
export function isFlagEnabled(
	stored: FeatureFlagState,
	flag: FeatureFlagKey,
	opts: FeatureFlagResolutionOptions = {}
): boolean {
	return resolveFlags(stored, opts)[flag] === true;
}

/**
 * Compute the new state after toggling `flag` to `value`, applying cascade rules.
 * Returns the keys that changed (besides `flag` itself) so the UI can surface a confirmation.
 */
export function applyToggle(
	stored: FeatureFlagState,
	flag: FeatureFlagKey,
	value: boolean,
	registry: FeatureFlagRegistry
): { next: FeatureFlagState; cascaded: FeatureFlagKey[] } {
	const definition = getFeatureFlagDefinition(registry, flag);
	if (!definition) throw new TypeError(`Unknown feature flag: ${flag}`);
	const next: FeatureFlagState = {
		...registeredFeatureFlagOverrides(stored, registry),
		[flag]: value,
	};
	const cascaded: FeatureFlagKey[] = [];

	if (!value) {
		// Cascade off: any flag whose `requires` includes this flag must also be off.
		// Plus any explicit `cascadesOff` list, plus any flag for which this was the
		// last ON member of a `requiresAny` group. Group satisfaction is checked
		// against the resolved view so defaults and dependency chains count — a
		// member that is stored ON but itself forced off cannot carry a group.
		const def = definition;
		const queue = new Set<FeatureFlagKey>(def.cascadesOff ?? []);
		const resolved = resolveFlags(next, { registry });
		for (const other of Object.values(registry)) {
			if (other.requires?.includes(flag)) {
				queue.add(other.key);
				continue;
			}
			for (const group of other.requiresAny ?? []) {
				if (group.includes(flag) && !group.some((member) => resolved[member])) {
					queue.add(other.key);
					break;
				}
			}
		}
		for (const key of queue) {
			if (next[key]) {
				next[key] = false;
				cascaded.push(key);
				// Recurse: turning this one off may cascade further.
				const more = applyToggle(next, key, false, registry);
				Object.assign(next, more.next);
				for (const c of more.cascaded) if (!cascaded.includes(c)) cascaded.push(c);
			}
		}
	} else {
		// Cascade on: any required flag must also be on. `requiresAny` members are
		// deliberately NOT auto-enabled — there is no principled pick among group
		// members, so the UI disables the toggle with a "needs one of: …" hint and
		// resolveFlags keeps the flag off until a member is on.
		const def = definition;
		for (const dep of def.requires ?? []) {
			if (!next[dep]) {
				next[dep] = true;
				cascaded.push(dep);
				const more = applyToggle(next, dep, true, registry);
				Object.assign(next, more.next);
				for (const c of more.cascaded) if (!cascaded.includes(c)) cascaded.push(c);
			}
		}
	}

	return { next, cascaded };
}

/** Copy only own boolean overrides for definitions present in this registry. */
export function registeredFeatureFlagOverrides(
	stored: FeatureFlagState,
	registry: FeatureFlagRegistry
): FeatureFlagState {
	const registered: FeatureFlagState = {};
	for (const definition of Object.values(registry)) {
		if (hasOwnKey(stored, definition.key)) {
			registered[definition.key] = stored[definition.key] === true;
		}
	}
	return registered;
}

function hasOwnKey(value: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Compute the docker compose profiles to activate for the given flag state.
 * Used by the setup CLI to generate `docker-compose.override.yml`.
 */
export function getActiveProfiles(
	stored: FeatureFlagState,
	opts: FeatureFlagResolutionOptions & { deliveryProvider?: string } = {}
): string[] {
	const resolved = resolveFlags(stored, opts);
	const profiles = new Set<string>();
	for (const def of Object.values(opts.registry ?? FEATURE_FLAGS)) {
		if (!resolved[def.key]) continue;
		for (const profile of def.dockerProfiles ?? []) profiles.add(profile);
	}
	// The built-in MTA is an opt-in service: it runs only when it is the delivery
	// provider, or when a receiving flag (postbox/inbox) needs it for inbound /
	// hosted send. The receiving cases add the 'mta' profile via their
	// dockerProfiles; the provider case is env-driven, so it is added here.
	//
	// TWO VOCABULARIES, one spelling. The question is the OWN-ARM one and is
	// asked through the catalog's declaration; the string added is a docker
	// COMPOSE PROFILE name, which belongs to compose and moves only when the
	// compose file does.
	if (isOwnSendProviderKind(opts.deliveryProvider)) profiles.add('mta');
	return Array.from(profiles).sort();
}

/**
 * Every compose profile the flag registry can ever produce — the profile
 * vocabulary the flag writers OWN.
 *
 * `getActiveProfiles` answers "which profiles do these flags want ON"; it does
 * NOT answer "which profiles should the host be running", because feature flags
 * are not the only thing that puts a profile in COMPOSE_PROFILES. The install
 * puts `tls` there for the Caddy edge and `dashboard` for the Convex dashboard,
 * and no flag can ever derive either. A writer that treats the derived set as
 * the whole truth therefore DELETES them — which, for `tls`, takes the
 * reverse proxy the operator is talking through offline.
 *
 * So the writers converge only this vocabulary and leave every other applied
 * profile alone (see `mergeComposeProfiles`).
 *
 * Plugin-contributed profiles belong to whichever registry the caller passes.
 * A caller that omits `registry` — the updater sidecar and the drift probe both
 * do, deliberately, so the two sides answer with the same vocabulary — treats a
 * plugin profile as install-owned and preserves it. Preserving a profile one
 * flag no longer wants is the recoverable direction; deleting one nothing can
 * re-derive is not.
 */
export function getFlagOwnedProfiles(opts: FeatureFlagResolutionOptions = {}): Set<string> {
	const owned = new Set<string>();
	for (const def of Object.values(opts.registry ?? FEATURE_FLAGS)) {
		for (const profile of def.dockerProfiles ?? []) owned.add(profile);
	}
	// The env-driven arm of `getActiveProfiles` — flag-derived in every sense
	// that matters here, since that function is the only thing that adds it.
	owned.add('mta');
	return owned;
}

/**
 * Compute the union of required env vars for the active flag set.
 * The CLI/wizard uses this to prompt only for env vars actually needed.
 */
export function getRequiredEnvVars(
	stored: FeatureFlagState,
	opts: FeatureFlagResolutionOptions & { deliveryProvider?: string } = {}
): string[] {
	const resolved = resolveFlags(stored, opts);
	const vars = new Set<string>();
	for (const def of Object.values(opts.registry ?? FEATURE_FLAGS)) {
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
export function needsDeliveryProvider(
	stored: FeatureFlagState,
	opts: FeatureFlagResolutionOptions = {}
): boolean {
	const resolved = resolveFlags(stored, opts);
	return SENDING_FLAGS_REQUIRING_DELIVERY.some((flag) => resolved[flag]);
}

/**
 * The delivery-provider kinds the bulk send path can route through, selected by
 * the `EMAIL_PROVIDER` env var.
 *
 * DERIVED from the send-provider catalog, not a local
 * list: this was the second of two declarations of the same union inside THIS
 * package, and the two did not import each other. `./sendProviderCatalog` is
 * data only, so the module stays browser-safe.
 *
 * The name survives the move because the setup surfaces read the union under it;
 * it is `SEND_TRANSPORT_KINDS` with another label, and the catalog suite pins
 * that they are the same list.
 */
export const DELIVERY_PROVIDER_KINDS = SEND_TRANSPORT_KINDS;
export type DeliveryProviderKind = CoreSendProviderKind;

/** True iff `value` names a known delivery provider (no implicit MTA default). */
export function isDeliveryProviderKind(value: string | undefined): value is DeliveryProviderKind {
	return isCoreSendProviderKind(value);
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
	// The catalog's `requiredEnvVars` IS this table — it was a per-kind switch
	// here, a per-kind list in the backend catalog and a third in
	// `./setupSendingPresets` until one derivation collapsed them. Which
	// variables are the presence gate (and why an optional refinement such as
	// `MANDRILL_WEBHOOK_KEY` is not one) is argued on the entries themselves.
	return [...(coreSendProviderCatalogEntry(provider)?.requiredEnvVars ?? [])];
}

/**
 * Group flag definitions by category for UI rendering.
 * Hosted-only categories are excluded unless `hosted: true`.
 */
export function getFlagsByCategory(
	opts: FeatureFlagResolutionOptions = {}
): Record<FeatureCategory, FeatureFlagDefinition[]> {
	const result: Record<string, FeatureFlagDefinition[]> = {};
	for (const def of Object.values(opts.registry ?? FEATURE_FLAGS)) {
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
	/** English name; the web renders `sharedPkg.featureFlags.packs.<key>.label`. */
	label: string;
	/** English description; the web renders `sharedPkg.featureFlags.packs.<key>.description`. */
	description: string;
	flags: readonly CoreFeatureFlagKey[];
}

export const FEATURE_PACKS: Record<FeaturePackKey, FeaturePack> = {
	emailClient: {
		key: 'emailClient',
		label: 'Email client',
		description: 'Inbox, chat, and personal mail (Postbox) as one bundle.',
		flags: ['inbox', 'chat', 'postbox', 'calendar.booking'],
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
		description:
			'Reply drafts, auto-send rules, a knowledge graph, an assistant and AI dashboards.',
		flags: [
			'ai',
			'ai.agent',
			'ai.autonomy',
			'ai.knowledge',
			'ai.knowledge.autoLink',
			'ai.knowledge.graphRetrieval',
			'ai.knowledge.analytics',
			'ai.assistant',
			'ai.visualizations',
		],
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
	value: boolean,
	registry: FeatureFlagRegistry
): { next: FeatureFlagState; cascaded: FeatureFlagKey[] } {
	const pack = FEATURE_PACKS[packKey];
	const packFlags = new Set<FeatureFlagKey>(pack.flags);
	let next: FeatureFlagState = registeredFeatureFlagOverrides(stored, registry);
	const cascaded = new Set<FeatureFlagKey>();
	for (const flag of pack.flags) {
		const result = applyToggle(next, flag, value, registry);
		next = result.next;
		for (const c of result.cascaded) {
			if (!packFlags.has(c)) cascaded.add(c);
		}
	}
	return { next, cascaded: Array.from(cascaded) };
}
