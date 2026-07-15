import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
	DELIVERY_PROVIDER_KINDS,
	FEATURE_FLAGS,
	FEATURE_PACKS,
	applyPackToggle,
	applyToggle,
	createFeatureFlagRegistry,
	getActiveProfiles,
	getDefaultFlags,
	getFlagsByCategory,
	getRequiredEnvVars,
	getSendPathRequiredEnv,
	isDeliveryProviderKind,
	isFlagEnabled,
	isPackEnabled,
	isPluginFeatureFlagDefinition,
	needsDeliveryProvider,
	resolveFlags,
	SENDING_FLAGS_REQUIRING_DELIVERY,
	type FeatureFlagKey,
	type FeatureFlagState,
	type PluginFeatureFlagDefinition,
	type PluginFeatureFlagKey,
} from '../featureFlags';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('featureFlags — defaults', () => {
	it('returns the registered defaults for a self-host install', () => {
		const flags = getDefaultFlags();
		expect(flags.campaigns).toBe(true);
		expect(flags.transactional).toBe(true);
		expect(flags.inbox).toBe(false);
		expect(flags.ai).toBe(false);
		expect(flags['scan.content']).toBe(true);
		expect(flags['domains.dkimRotation']).toBe(true);
	});

	it('excludes hosted-only flags from the self-host default set', () => {
		const flags = getDefaultFlags();
		expect(flags['billing.stripe']).toBeUndefined();
		expect(flags.multiTenancy).toBeUndefined();
	});

	it('includes hosted-only flags when hosted=true', () => {
		const flags = getDefaultFlags({ hosted: true });
		expect(flags['billing.stripe']).toBe(false);
		expect(flags.multiTenancy).toBe(false);
	});
});

describe('featureFlags — dependency cascade', () => {
	it('disables ai.agent when inbox is off, regardless of stored value', () => {
		const stored: FeatureFlagState = { ai: true, inbox: false, 'ai.agent': true };
		const resolved = resolveFlags(stored);
		expect(resolved['ai.agent']).toBe(false);
	});

	it('disables inbox.codeTasks when either inbox or ai.agent is off', () => {
		const noInbox: FeatureFlagState = {
			'inbox.codeTasks': true,
			inbox: false,
			'ai.agent': true,
			ai: true,
		};
		expect(resolveFlags(noInbox)['inbox.codeTasks']).toBe(false);

		const noAgent: FeatureFlagState = { 'inbox.codeTasks': true, inbox: true, 'ai.agent': false };
		expect(resolveFlags(noAgent)['inbox.codeTasks']).toBe(false);

		const both: FeatureFlagState = {
			'inbox.codeTasks': true,
			inbox: true,
			'ai.agent': true,
			ai: true,
		};
		expect(resolveFlags(both)['inbox.codeTasks']).toBe(true);
	});

	it('cascades through chains: codeTasks requires ai.agent which requires inbox + ai', () => {
		// AI master off → ai.agent off → codeTasks off
		const stored: FeatureFlagState = {
			ai: false,
			'ai.agent': true,
			inbox: true,
			'inbox.codeTasks': true,
		};
		const resolved = resolveFlags(stored);
		expect(resolved.ai).toBe(false);
		expect(resolved['ai.agent']).toBe(false);
		expect(resolved['inbox.codeTasks']).toBe(false);
	});
});

describe('featureFlags — applyToggle', () => {
	it('cascades off when turning off a parent', () => {
		const stored: FeatureFlagState = {
			ai: true,
			'ai.agent': true,
			inbox: true,
			'ai.autonomy': true,
		};
		const { next, cascaded } = applyToggle(stored, 'inbox', false);
		expect(next.inbox).toBe(false);
		expect(next['ai.agent']).toBe(false);
		expect(next['ai.autonomy']).toBe(false);
		expect(cascaded).toContain('ai.agent');
		expect(cascaded).toContain('ai.autonomy');
	});

	it('master ai off cascades off all ai.* sub-flags', () => {
		const stored: FeatureFlagState = {
			ai: true,
			'ai.agent': true,
			'ai.autonomy': true,
			'ai.knowledge': true,
			'ai.visualizations': true,
			inbox: true,
		};
		const { next } = applyToggle(stored, 'ai', false);
		expect(next.ai).toBe(false);
		expect(next['ai.agent']).toBe(false);
		expect(next['ai.autonomy']).toBe(false);
		expect(next['ai.knowledge']).toBe(false);
		expect(next['ai.visualizations']).toBe(false);
	});

	it('cascades on when turning on a child auto-enables required parents', () => {
		const stored: FeatureFlagState = { ai: false, 'ai.agent': false, inbox: false };
		const { next, cascaded } = applyToggle(stored, 'ai.agent', true);
		expect(next['ai.agent']).toBe(true);
		expect(next.ai).toBe(true);
		expect(next.inbox).toBe(true);
		expect(cascaded).toEqual(expect.arrayContaining(['ai', 'inbox']));
	});

	it('toggling campaigns.archive does not cascade off campaigns', () => {
		const stored: FeatureFlagState = { campaigns: true, 'campaigns.archive': true };
		const { next, cascaded } = applyToggle(stored, 'campaigns.archive', false);
		expect(next.campaigns).toBe(true);
		expect(next['campaigns.archive']).toBe(false);
		expect(cascaded).toEqual([]);
	});

	it('turning off campaigns cascades off campaigns.archive', () => {
		const stored: FeatureFlagState = { campaigns: true, 'campaigns.archive': true };
		const { next, cascaded } = applyToggle(stored, 'campaigns', false);
		expect(next.campaigns).toBe(false);
		expect(next['campaigns.archive']).toBe(false);
		expect(cascaded).toContain('campaigns.archive');
	});
});

describe('featureFlags — env vars and docker profiles', () => {
	it('aggregates required env vars from active flags', () => {
		const stored: FeatureFlagState = { ai: true, 'ai.agent': true, inbox: true, 'scan.urls': true };
		const vars = getRequiredEnvVars(stored);
		expect(vars).toContain('LLM_PROVIDER');
		expect(vars).toContain('LLM_API_KEY');
		expect(vars).toContain('GOOGLE_SAFE_BROWSING_API_KEY');
	});

	it('omits env vars for disabled flags', () => {
		const stored: FeatureFlagState = { ai: false, 'scan.urls': false };
		const vars = getRequiredEnvVars(stored);
		expect(vars).not.toContain('LLM_API_KEY');
		expect(vars).not.toContain('GOOGLE_SAFE_BROWSING_API_KEY');
	});

	it('aggregates docker profiles from active flags', () => {
		const stored: FeatureFlagState = {
			ai: true,
			automations: true,
			webhooks: true,
			inbox: true,
			postbox: true,
		};
		const profiles = getActiveProfiles(stored);
		expect(profiles).toContain('ai');
		expect(profiles).toContain('personal-mail');
		// inbox + postbox both need the (now opt-in) MTA for inbound / hosted send.
		expect(profiles).toContain('mta');
		// automations/webhooks run inside the always-on Convex backend — they must
		// NOT activate compose profiles (the services they once pointed at do not exist).
		expect(profiles).not.toContain('scheduler');
		expect(profiles).not.toContain('webhook-dispatcher');
		expect(profiles).not.toContain('inbox-mta');
		expect(profiles).not.toContain('ai-worker');
	});

	it('activates the mta profile when MTA is the delivery provider (env-driven)', () => {
		// No receiving flag, so the MTA profile comes only from the provider.
		const sendingOnly: FeatureFlagState = { campaigns: true, inbox: false, postbox: false };
		expect(getActiveProfiles(sendingOnly)).not.toContain('mta');
		expect(getActiveProfiles(sendingOnly, { deliveryProvider: 'mta' })).toContain('mta');
		// resend/ses do not run the built-in MTA.
		expect(getActiveProfiles(sendingOnly, { deliveryProvider: 'resend' })).not.toContain('mta');
	});

	it('does not include profiles for flags that resolve to off due to deps', () => {
		// codeTasks requires inbox + ai.agent — without them, no profile
		const stored: FeatureFlagState = { 'inbox.codeTasks': true, inbox: false };
		const profiles = getActiveProfiles(stored);
		expect(profiles).not.toContain('inbox-codetasks');
	});
});

describe('featureFlags — registry sanity', () => {
	it('every requires target exists in the registry', () => {
		for (const def of Object.values(FEATURE_FLAGS)) {
			for (const dep of def.requires ?? []) {
				expect(Object.hasOwn(FEATURE_FLAGS, dep), `${def.key} requires unknown flag ${dep}`).toBe(
					true
				);
			}
			for (const target of def.cascadesOff ?? []) {
				expect(
					Object.hasOwn(FEATURE_FLAGS, target),
					`${def.key} cascadesOff unknown flag ${target}`
				).toBe(true);
			}
		}
	});

	it('isFlagEnabled is a stable wrapper around resolveFlags', () => {
		const stored: FeatureFlagState = { campaigns: true, inbox: false };
		expect(isFlagEnabled(stored, 'campaigns')).toBe(true);
		expect(isFlagEnabled(stored, 'inbox')).toBe(false);
	});
});

describe('featureFlags — plugin namespace', () => {
	const pluginFlag = {
		key: 'plugin.deliverability-lab',
		category: 'plugins',
		label: 'Deliverability Lab',
		description: 'Bundled plugin from @example/deliverability-lab.',
		default: false,
		requiredEnvVars: ['SEEDBOX_API_KEY'],
		requiredCapabilities: ['campaigns:read', 'send:gate'],
		pluginPackageName: '@example/deliverability-lab',
	} satisfies PluginFeatureFlagDefinition;

	it('types plugin flags in an open, namespaced key space', () => {
		const key: PluginFeatureFlagKey = 'plugin.deliverability-lab';
		const featureKey: FeatureFlagKey = key;
		expect(featureKey).toBe(pluginFlag.key);
	});

	it('registers plugin definitions without changing the core registry', () => {
		const registry = createFeatureFlagRegistry([pluginFlag]);
		expect(registry[pluginFlag.key]).toMatchObject(pluginFlag);
		expect(isPluginFeatureFlagDefinition(registry[pluginFlag.key])).toBe(true);
		expect(FEATURE_FLAGS).not.toHaveProperty(pluginFlag.key);
		expect(getFlagsByCategory({ registry }).plugins).toEqual([registry[pluginFlag.key]]);
	});

	it('honors a plugin default, explicit override, and disable', () => {
		const defaultOn = { ...pluginFlag, default: true } satisfies PluginFeatureFlagDefinition;
		const registry = createFeatureFlagRegistry([defaultOn]);

		expect(resolveFlags({}, { registry })[defaultOn.key]).toBe(true);
		expect(resolveFlags({ [defaultOn.key]: false }, { registry })[defaultOn.key]).toBe(false);
		const { next } = applyToggle({}, defaultOn.key, false, registry);
		expect(next[defaultOn.key]).toBe(false);
	});

	it('includes plugin env requirements only while the plugin resolves on', () => {
		const registry = createFeatureFlagRegistry([pluginFlag]);
		expect(getRequiredEnvVars({ [pluginFlag.key]: true }, { registry })).toContain(
			'SEEDBOX_API_KEY'
		);
		expect(getRequiredEnvVars({ [pluginFlag.key]: false }, { registry })).not.toContain(
			'SEEDBOX_API_KEY'
		);
	});

	it.each([
		['an unnamespaced key', { ...pluginFlag, key: 'deliverability-lab' }],
		['an empty plugin id', { ...pluginFlag, key: 'plugin.' }],
		['an invalid plugin id', { ...pluginFlag, key: 'plugin.Bad_Id' }],
		['the wrong category', { ...pluginFlag, category: 'integrations' }],
	] as const)('rejects %s', (_label, definition) => {
		expect(() =>
			createFeatureFlagRegistry([definition as unknown as PluginFeatureFlagDefinition])
		).toThrow('Invalid plugin feature flag definition');
	});

	const inheritedDefinition = Object.create(pluginFlag) as unknown;
	const accessorDefinition = {
		...pluginFlag,
		get label() {
			return 'Inherited behavior';
		},
	};
	const malformedDefinitions: readonly (readonly [string, unknown])[] = [
		['null', null],
		['undefined', undefined],
		['a string', 'plugin.definition'],
		['a number', 1],
		['a boolean', true],
		['an array', []],
		['a function', () => pluginFlag],
		['inherited fields', inheritedDefinition],
		['an accessor field', accessorDefinition],
		['a missing category', { ...pluginFlag, category: undefined }],
		['a non-string category', { ...pluginFlag, category: 1 }],
		['a missing key', { ...pluginFlag, key: undefined }],
		['a non-string key', { ...pluginFlag, key: false }],
		['a missing label', { ...pluginFlag, label: undefined }],
		['a non-string label', { ...pluginFlag, label: 1 }],
		['a missing description', { ...pluginFlag, description: undefined }],
		['a non-string description', { ...pluginFlag, description: false }],
		['a missing default', { ...pluginFlag, default: undefined }],
		['a non-boolean default', { ...pluginFlag, default: 'false' }],
		['a missing package name', { ...pluginFlag, pluginPackageName: undefined }],
		['a non-string package name', { ...pluginFlag, pluginPackageName: 1 }],
		['missing capabilities', { ...pluginFlag, requiredCapabilities: undefined }],
		['non-array capabilities', { ...pluginFlag, requiredCapabilities: 'mail:read' }],
		['non-array requires', { ...pluginFlag, requires: 'ai' }],
		['non-string requires', { ...pluginFlag, requires: ['ai', 1] }],
		['non-array cascadesOff', { ...pluginFlag, cascadesOff: false }],
		['non-string cascadesOff', { ...pluginFlag, cascadesOff: [{}] }],
		['non-array requiredEnvVars', { ...pluginFlag, requiredEnvVars: 'TOKEN' }],
		['non-string requiredEnvVars', { ...pluginFlag, requiredEnvVars: [1] }],
		['non-array dockerProfiles', { ...pluginFlag, dockerProfiles: true }],
		['non-string dockerProfiles', { ...pluginFlag, dockerProfiles: [null] }],
		['a non-boolean hostedOnly', { ...pluginFlag, hostedOnly: 'true' }],
		['non-string capabilities', { ...pluginFlag, requiredCapabilities: ['mail:read', 1] }],
	];

	it.each(malformedDefinitions)(
		'rejects %s with a deterministic runtime error',
		(_label, value) => {
			expect(isPluginFeatureFlagDefinition(value)).toBe(false);
			expect(() =>
				createFeatureFlagRegistry([value as unknown as PluginFeatureFlagDefinition])
			).toThrowError(/^Invalid plugin feature flag definition$/);
		}
	);

	it('ignores stale and malformed stored plugin keys during resolution', () => {
		const registry = createFeatureFlagRegistry([pluginFlag]);
		const stored = {
			[pluginFlag.key]: true,
			'plugin.removed': true,
			'plugin.Bad_Id': true,
		} as FeatureFlagState;
		const resolved = resolveFlags(stored, { registry });

		expect(resolved[pluginFlag.key]).toBe(true);
		expect(Object.hasOwn(resolved, 'plugin.removed')).toBe(false);
		expect(Object.hasOwn(resolved, 'plugin.Bad_Id')).toBe(false);
		expect(isFlagEnabled(stored, 'plugin.removed', { registry })).toBe(false);
	});

	it.each(['toString', 'constructor', '__proto__'])(
		'rejects inherited object key %s without mutating the input',
		(key) => {
			const stored: FeatureFlagState = { inbox: true };
			expect(() => applyToggle(stored, key as FeatureFlagKey, true)).toThrow(
				`Unknown feature flag: ${key}`
			);
			expect(stored).toEqual({ inbox: true });
		}
	);

	it('rejects duplicate definitions and dangling dependencies deterministically', () => {
		expect(() => createFeatureFlagRegistry([pluginFlag, pluginFlag])).toThrow(
			'Duplicate feature flag definition'
		);
		expect(() =>
			createFeatureFlagRegistry([
				{ ...pluginFlag, requires: ['plugin.not-installed'] as FeatureFlagKey[] },
			])
		).toThrow('requires unknown feature flag plugin.not-installed');
		expect(() =>
			createFeatureFlagRegistry([
				{ ...pluginFlag, cascadesOff: ['plugin.not-installed'] as FeatureFlagKey[] },
			])
		).toThrow('cascades to unknown feature flag plugin.not-installed');
	});

	it('bounds the number of plugin definitions before iterating them', () => {
		const definitions = Array.from({ length: 129 }, (_, index) => ({
			...pluginFlag,
			key: `plugin.policy-pack-${index}` as PluginFeatureFlagKey,
		}));
		expect(() => createFeatureFlagRegistry(definitions)).toThrow(
			'At most 128 plugin feature flags may be registered'
		);
	});

	it('snapshots and freezes plugin metadata', () => {
		const requiredEnvVars = ['SEEDBOX_API_KEY'];
		const requiredCapabilities = ['send:gate'];
		const registry = createFeatureFlagRegistry([
			{ ...pluginFlag, requiredEnvVars, requiredCapabilities },
		]);
		requiredEnvVars.push('LATE_SECRET');
		requiredCapabilities.push('contacts:write');

		expect(registry[pluginFlag.key]?.requiredEnvVars).toEqual(['SEEDBOX_API_KEY']);
		expect(registry[pluginFlag.key]?.requiredCapabilities).toEqual(['send:gate']);
		expect(Object.isFrozen(registry)).toBe(true);
		expect(Object.isFrozen(registry[pluginFlag.key])).toBe(true);
	});
});

describe('featureFlags — feature packs', () => {
	it('every pack member is a registered flag', () => {
		for (const pack of Object.values(FEATURE_PACKS)) {
			for (const flag of pack.flags) {
				expect(
					FEATURE_FLAGS[flag],
					`pack ${pack.key} references unknown flag ${flag}`
				).toBeDefined();
			}
		}
	});

	it('isPackEnabled returns "on" when every member is enabled', () => {
		const stored: FeatureFlagState = { inbox: true, chat: true, postbox: true };
		expect(isPackEnabled(stored, 'emailClient')).toBe('on');
	});

	it('isPackEnabled returns "off" when every member is disabled', () => {
		const stored: FeatureFlagState = { inbox: false, chat: false, postbox: false };
		expect(isPackEnabled(stored, 'emailClient')).toBe('off');
	});

	it('isPackEnabled returns "partial" when some members are enabled', () => {
		const stored: FeatureFlagState = { inbox: true, chat: false, postbox: true };
		expect(isPackEnabled(stored, 'emailClient')).toBe('partial');
	});

	it('isPackEnabled respects dependency cascade (inbox off makes ai.agent resolve off)', () => {
		const stored: FeatureFlagState = { ai: true, 'ai.agent': true, inbox: false };
		// ai.agent requires inbox, so resolves to off → pack is partial
		expect(isPackEnabled(stored, 'ai')).toBe('partial');
	});

	it('applyPackToggle off disables every pack member', () => {
		const stored: FeatureFlagState = { inbox: true, chat: true, postbox: true };
		const { next } = applyPackToggle(stored, 'emailClient', false);
		expect(next.inbox).toBe(false);
		expect(next.chat).toBe(false);
		expect(next.postbox).toBe(false);
	});

	it('applyPackToggle on enables every pack member', () => {
		const stored: FeatureFlagState = { inbox: false, chat: false, postbox: false };
		const { next } = applyPackToggle(stored, 'emailClient', true);
		expect(next.inbox).toBe(true);
		expect(next.chat).toBe(true);
		expect(next.postbox).toBe(true);
	});

	it('applyPackToggle for marketing on flips campaigns/automations/transactional all on', () => {
		const stored: FeatureFlagState = { campaigns: false, automations: false, transactional: false };
		const { next } = applyPackToggle(stored, 'marketing', true);
		expect(next.campaigns).toBe(true);
		expect(next.automations).toBe(true);
		expect(next.transactional).toBe(true);
	});

	it('applyPackToggle for ai off cascades and turns off inbox.codeTasks', () => {
		const stored: FeatureFlagState = {
			ai: true,
			'ai.agent': true,
			'ai.autonomy': true,
			'ai.knowledge': true,
			'ai.visualizations': true,
			inbox: true,
			'inbox.codeTasks': true,
		};
		const { next, cascaded } = applyPackToggle(stored, 'ai', false);
		expect(next.ai).toBe(false);
		expect(next['ai.agent']).toBe(false);
		expect(next['inbox.codeTasks']).toBe(false);
		expect(cascaded).toContain('inbox.codeTasks');
	});

	it('applyPackToggle for emailClient on auto-enables required deps via cascade', () => {
		// Turning on chat/inbox/postbox has no upstream deps, but the cascade
		// machinery should still produce a consistent state.
		const stored: FeatureFlagState = { inbox: false, chat: false, postbox: false };
		const { next } = applyPackToggle(stored, 'emailClient', true);
		expect(resolveFlags(next).inbox).toBe(true);
		expect(resolveFlags(next).chat).toBe(true);
		expect(resolveFlags(next).postbox).toBe(true);
	});

	it('applyPackToggle round-trip preserves unrelated flags', () => {
		const stored: FeatureFlagState = {
			campaigns: true,
			inbox: false,
			chat: false,
			postbox: true,
		};
		const turnedOn = applyPackToggle(stored, 'emailClient', true);
		const turnedOff = applyPackToggle(turnedOn.next, 'emailClient', false);
		expect(turnedOff.next.campaigns).toBe(true);
	});
});

describe('featureFlags — knowledge-graph sub-flags', () => {
	const KG_CHILDREN = [
		'ai.knowledge.autoLink',
		'ai.knowledge.graphRetrieval',
		'ai.knowledge.analytics',
	] as const satisfies readonly FeatureFlagKey[];

	it('registers each child of ai.knowledge, default off, requiring ai.knowledge', () => {
		for (const key of KG_CHILDREN) {
			const def = FEATURE_FLAGS[key];
			expect(def, `${key} missing from registry`).toBeDefined();
			expect(def.default).toBe(false);
			expect(def.requires).toEqual(['ai.knowledge']);
			expect(def.category).toBe('ai');
		}
	});

	it('resolves each child off when ai.knowledge is off, regardless of stored value', () => {
		for (const key of KG_CHILDREN) {
			const stored: FeatureFlagState = { ai: true, 'ai.knowledge': false, [key]: true };
			expect(resolveFlags(stored)[key]).toBe(false);
		}
	});

	it('cascades each child off when the master ai flag is turned off', () => {
		const stored: FeatureFlagState = {
			ai: true,
			'ai.knowledge': true,
			'ai.knowledge.autoLink': true,
			'ai.knowledge.graphRetrieval': true,
			'ai.knowledge.analytics': true,
		};
		const { next } = applyToggle(stored, 'ai', false);
		for (const key of KG_CHILDREN) {
			expect(next[key]).toBe(false);
		}
	});

	it('lists each child in the ai feature pack', () => {
		for (const key of KG_CHILDREN) {
			expect(FEATURE_PACKS.ai.flags).toContain(key);
		}
	});

	it('lists each child in the master ai cascadesOff', () => {
		for (const key of KG_CHILDREN) {
			expect(FEATURE_FLAGS.ai.cascadesOff).toContain(key);
		}
	});
});

describe('featureFlags — external mailbox (mail.external)', () => {
	it('defaults to off', () => {
		expect(getDefaultFlags()['mail.external']).toBe(false);
	});

	it('is independent of postbox — enabling it does NOT force the hosted postbox on', () => {
		const resolved = resolveFlags({ 'mail.external': true });
		expect(resolved['mail.external']).toBe(true);
		expect(resolved.postbox).toBe(false);
	});

	it('activates the external-mail docker profile when on', () => {
		expect(getActiveProfiles({ 'mail.external': true })).toContain('external-mail');
	});

	it('does not activate the hosted personal-mail profile (postbox-only)', () => {
		expect(getActiveProfiles({ 'mail.external': true })).not.toContain('personal-mail');
	});
});

describe('featureFlags — needsDeliveryProvider', () => {
	it('every SENDING_FLAGS_REQUIRING_DELIVERY entry is a real flag and excludes campaigns.archive', () => {
		for (const flag of SENDING_FLAGS_REQUIRING_DELIVERY) {
			expect(FEATURE_FLAGS[flag], `${flag} is not a registered flag`).toBeDefined();
		}
		expect(SENDING_FLAGS_REQUIRING_DELIVERY).not.toContain('campaigns.archive');
	});

	it('is true when any bulk sending flag is on', () => {
		expect(
			needsDeliveryProvider({ campaigns: true, transactional: false, automations: false })
		).toBe(true);
		expect(
			needsDeliveryProvider({ campaigns: false, transactional: true, automations: false })
		).toBe(true);
		expect(
			needsDeliveryProvider({ campaigns: false, transactional: false, automations: true })
		).toBe(true);
	});

	it('is false for receiving-only / IMAP-only postures', () => {
		const imapOnly: FeatureFlagState = {
			campaigns: false,
			'campaigns.archive': false,
			transactional: false,
			automations: false,
			'mail.external': true,
		};
		expect(needsDeliveryProvider(imapOnly)).toBe(false);
		// mail.external is a receiving flag — it must never imply a delivery provider.
		expect(
			needsDeliveryProvider({
				'mail.external': true,
				campaigns: false,
				transactional: false,
				automations: false,
			})
		).toBe(false);
	});

	it('honors the resolveFlags cascade (campaigns.archive alone cannot force a provider)', () => {
		// campaigns.archive requires campaigns; with campaigns off it resolves off,
		// and archive is not itself a delivery-requiring flag.
		expect(
			needsDeliveryProvider({
				campaigns: false,
				'campaigns.archive': true,
				transactional: false,
				automations: false,
			})
		).toBe(false);
	});
});

describe('featureFlags — getSendPathRequiredEnv', () => {
	it('returns the MTA send-path creds for provider=mta', () => {
		expect(getSendPathRequiredEnv('mta')).toEqual(['MTA_API_URL', 'MTA_API_KEY']);
	});

	it('returns the Resend key for provider=resend', () => {
		expect(getSendPathRequiredEnv('resend')).toEqual(['RESEND_API_KEY']);
	});

	it('returns the SES region + creds for provider=ses', () => {
		expect(getSendPathRequiredEnv('ses')).toEqual([
			'AWS_SES_REGION',
			'AWS_SES_ACCESS_KEY_ID',
			'AWS_SES_SECRET_ACCESS_KEY',
		]);
	});

	it('returns the relay host + creds for provider=smtp', () => {
		expect(getSendPathRequiredEnv('smtp')).toEqual([
			'SMTP_RELAY_HOST',
			'SMTP_RELAY_USERNAME',
			'SMTP_RELAY_PASSWORD',
		]);
	});

	it('returns [] for an unset or unrecognized provider (no implicit default)', () => {
		expect(getSendPathRequiredEnv(undefined)).toEqual([]);
		expect(getSendPathRequiredEnv('')).toEqual([]);
		expect(getSendPathRequiredEnv('sendgrid')).toEqual([]);
	});

	it('covers every declared delivery provider kind with at least one required var', () => {
		for (const kind of DELIVERY_PROVIDER_KINDS) {
			expect(getSendPathRequiredEnv(kind).length).toBeGreaterThan(0);
		}
	});

	it('isDeliveryProviderKind recognizes only mta|resend|ses|smtp', () => {
		expect(isDeliveryProviderKind('mta')).toBe(true);
		expect(isDeliveryProviderKind('resend')).toBe(true);
		expect(isDeliveryProviderKind('ses')).toBe(true);
		expect(isDeliveryProviderKind('smtp')).toBe(true);
		expect(isDeliveryProviderKind('sendgrid')).toBe(false);
		expect(isDeliveryProviderKind(undefined)).toBe(false);
	});
});

describe('featureFlags — getRequiredEnvVars folds in the send path', () => {
	it('adds provider creds when a sending feature is active and the provider is known', () => {
		const vars = getRequiredEnvVars({ campaigns: true }, { deliveryProvider: 'mta' });
		expect(vars).toContain('MTA_API_URL');
		expect(vars).toContain('MTA_API_KEY');
	});

	it('does not add send-path creds when no sending feature is active', () => {
		const vars = getRequiredEnvVars(
			{ campaigns: false, transactional: false, automations: false, 'mail.external': true },
			{ deliveryProvider: 'mta' }
		);
		expect(vars).not.toContain('MTA_API_URL');
	});

	it('is unchanged from prior behavior when no deliveryProvider is supplied', () => {
		const vars = getRequiredEnvVars({ campaigns: true });
		expect(vars).not.toContain('MTA_API_URL');
		expect(vars).not.toContain('RESEND_API_KEY');
	});

	it('folds the SES creds in for provider=ses', () => {
		const vars = getRequiredEnvVars({ transactional: true }, { deliveryProvider: 'ses' });
		expect(vars).toEqual(
			expect.arrayContaining([
				'AWS_SES_REGION',
				'AWS_SES_ACCESS_KEY_ID',
				'AWS_SES_SECRET_ACCESS_KEY',
			])
		);
	});
});

describe('featureFlags — infra templates stay in sync', () => {
	const word = (haystack: string, needle: string) =>
		new RegExp(`(^|[^A-Za-z0-9_])${needle}([^A-Za-z0-9_]|$)`).test(haystack);

	it('every dockerProfiles value appears in the VPS compose template', () => {
		const compose = readFileSync(
			resolve(REPO_ROOT, 'infra/templates/docker-compose.vps.yml'),
			'utf-8'
		);
		const missing = Object.values(FEATURE_FLAGS)
			.flatMap((def) => def.dockerProfiles ?? [])
			.filter((profile) => !word(compose, profile))
			.sort();
		expect(missing).toEqual([]);
	});

	it('every non-hosted required env var is documented in the VPS env template', () => {
		const template = readFileSync(resolve(REPO_ROOT, 'infra/templates/.env.vps.template'), 'utf-8');
		const missing = Object.values(FEATURE_FLAGS)
			.filter((def) => !def.hostedOnly)
			.flatMap((def) => def.requiredEnvVars ?? [])
			.filter((envVar) => !word(template, envVar))
			.sort();
		expect(missing).toEqual([]);
	});
});

describe('featureFlags — sealed-mail flags', () => {
	it('registers senderAuthBadges and sealedMail, both default ON', () => {
		expect(FEATURE_FLAGS.senderAuthBadges).toBeDefined();
		expect(FEATURE_FLAGS.sealedMail).toBeDefined();
		expect(FEATURE_FLAGS.senderAuthBadges.default).toBe(true);
		expect(FEATURE_FLAGS.sealedMail.default).toBe(true);
	});

	it('carries both flags ON in the raw default flag set', () => {
		const flags = getDefaultFlags();
		expect(flags.senderAuthBadges).toBe(true);
		expect(flags.sealedMail).toBe(true);
	});

	it('gates both flags off on a deployment without the Postbox plane', () => {
		// The raw defaults are ON, but they require the Postbox plane; a
		// deployment with postbox off resolves them back off (no personal mail).
		const resolved = resolveFlags({ postbox: false });
		expect(resolved.senderAuthBadges).toBe(false);
		expect(resolved.sealedMail).toBe(false);
	});

	it('keeps sealedMail off unless its dependencies are on', () => {
		const stored: FeatureFlagState = { sealedMail: true };
		const resolved = resolveFlags(stored);
		expect(resolved.sealedMail).toBe(false);
	});

	it('resolves sealedMail on only when postbox and senderAuthBadges are on', () => {
		const stored: FeatureFlagState = {
			postbox: true,
			senderAuthBadges: true,
			sealedMail: true,
		};
		const resolved = resolveFlags(stored);
		expect(resolved.sealedMail).toBe(true);
	});
});
