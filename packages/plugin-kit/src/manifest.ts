import type { PluginCapability } from './capabilities';

export const PLUGIN_CONTRIBUTION_KINDS = [
	'sendTransports',
	'agentSteps',
	'draftStrategies',
	'sendGates',
	'lifecycleEffects',
	'assistantTools',
	'automationTriggers',
	'automationSteps',
	'automationConditions',
	'inboundAdapters',
	'webhookEvents',
	'importProviders',
	'channelAdapters',
	'crons',
	'emailBlocks',
	'commands',
	'navItems',
	'settingsPanels',
	'panels',
	'widgets',
	'taskCards',
] as const;

export type PluginContributionKind = (typeof PLUGIN_CONTRIBUTION_KINDS)[number];

/**
 * Framework-specific contribution interfaces are introduced with the seam
 * that consumes them. PP-01 only fixes their manifest buckets.
 */
export type PluginContributions = Readonly<
	Partial<Record<PluginContributionKind, readonly unknown[]>>
>;

export interface PluginFeatureFlagDefinition {
	readonly default: boolean;
	readonly requiredEnvVars?: readonly string[];
}

export interface PluginLlmBudget {
	readonly dailyUsd: number;
}

export type PluginComponentLoader = () => Promise<unknown>;

export interface PluginManifest {
	readonly id: string;
	readonly version: string;
	readonly capabilities: readonly PluginCapability[];
	readonly contributes?: PluginContributions;
	readonly flag?: PluginFeatureFlagDefinition;
	readonly llmBudget?: PluginLlmBudget;
	readonly component?: PluginComponentLoader;
}

export type PluginManifestIssueCode =
	| 'accessor_not_allowed'
	| 'duplicate'
	| 'invalid_format'
	| 'invalid_type'
	| 'missing'
	| 'unknown_field';

export interface PluginManifestIssue {
	readonly code: PluginManifestIssueCode;
	readonly path: string;
	readonly message: string;
}

export type PluginManifestValidation =
	| { readonly ok: true; readonly manifest: PluginManifest }
	| { readonly ok: false; readonly issues: readonly PluginManifestIssue[] };

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CAPABILITY =
	/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*:[a-z*][a-z0-9*-]*(?:\.[a-z][a-z0-9-]*)*$/;
const ENV_VAR = /^[A-Z][A-Z0-9_]*$/;
const TOP_LEVEL_FIELDS = new Set([
	'id',
	'version',
	'capabilities',
	'contributes',
	'flag',
	'llmBudget',
	'component',
]);
const CONTRIBUTION_KINDS = new Set<string>(PLUGIN_CONTRIBUTION_KINDS);

export class PluginManifestError extends Error {
	readonly issues: readonly PluginManifestIssue[];

	constructor(issues: readonly PluginManifestIssue[]) {
		super(
			`Invalid plugin manifest: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`
		);
		this.name = 'PluginManifestError';
		this.issues = issues;
	}
}

export function definePlugin<const TManifest extends PluginManifest>(
	manifest: TManifest
): TManifest {
	parsePluginManifest(manifest);
	return manifest;
}

export function parsePluginManifest(value: unknown): PluginManifest {
	const result = validatePluginManifest(value);
	if (!result.ok) throw new PluginManifestError(result.issues);
	return result.manifest;
}

export function isPluginManifest(value: unknown): value is PluginManifest {
	return validatePluginManifest(value).ok;
}

export function validatePluginManifest(value: unknown): PluginManifestValidation {
	const issues: PluginManifestIssue[] = [];
	if (!isRecord(value)) {
		addIssue(issues, 'invalid_type', '$', 'must be a plain object');
		return { ok: false, issues };
	}

	for (const key of Object.keys(value)) {
		if (!TOP_LEVEL_FIELDS.has(key))
			addIssue(issues, 'unknown_field', `$.${key}`, 'is not supported');
	}

	const id = readDataProperty(value, 'id', issues, true);
	if (typeof id === 'string') {
		if (id.length > 64 || !PLUGIN_ID.test(id)) {
			addIssue(
				issues,
				'invalid_format',
				'$.id',
				'must be a lowercase kebab-case id of at most 64 characters'
			);
		}
	} else if (id !== undefined) {
		addIssue(issues, 'invalid_type', '$.id', 'must be a string');
	}

	const version = readDataProperty(value, 'version', issues, true);
	if (typeof version === 'string') {
		if (!SEMVER.test(version))
			addIssue(issues, 'invalid_format', '$.version', 'must be a semantic version');
	} else if (version !== undefined) {
		addIssue(issues, 'invalid_type', '$.version', 'must be a string');
	}

	validateCapabilities(readDataProperty(value, 'capabilities', issues, true), issues);
	validateContributions(readDataProperty(value, 'contributes', issues), issues);
	validateFlag(readDataProperty(value, 'flag', issues), issues);
	validateLlmBudget(readDataProperty(value, 'llmBudget', issues), issues);

	const component = readDataProperty(value, 'component', issues);
	if (component !== undefined && typeof component !== 'function') {
		addIssue(issues, 'invalid_type', '$.component', 'must be an async component loader');
	}

	return issues.length === 0
		? { ok: true, manifest: value as unknown as PluginManifest }
		: { ok: false, issues };
}

function validateCapabilities(value: unknown, issues: PluginManifestIssue[]): void {
	if (!Array.isArray(value)) {
		if (value !== undefined) addIssue(issues, 'invalid_type', '$.capabilities', 'must be an array');
		return;
	}
	const seen = new Set<string>();
	for (const [index, capability] of value.entries()) {
		const path = `$.capabilities[${index}]`;
		if (typeof capability !== 'string') {
			addIssue(issues, 'invalid_type', path, 'must be a string');
		} else if (!CAPABILITY.test(capability)) {
			addIssue(issues, 'invalid_format', path, 'must use the lowercase domain:action form');
		} else if (seen.has(capability)) {
			addIssue(issues, 'duplicate', path, `duplicates capability ${capability}`);
		} else {
			seen.add(capability);
		}
	}
}

function validateContributions(value: unknown, issues: PluginManifestIssue[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		addIssue(issues, 'invalid_type', '$.contributes', 'must be a plain object');
		return;
	}
	for (const key of Object.keys(value)) {
		const path = `$.contributes.${key}`;
		if (!CONTRIBUTION_KINDS.has(key)) {
			addIssue(issues, 'unknown_field', path, 'is not a known contribution kind');
			continue;
		}
		const contribution = readDataProperty(value, key, issues);
		if (!Array.isArray(contribution)) addIssue(issues, 'invalid_type', path, 'must be an array');
	}
}

function validateFlag(value: unknown, issues: PluginManifestIssue[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		addIssue(issues, 'invalid_type', '$.flag', 'must be a plain object');
		return;
	}
	validateKnownFields(value, '$.flag', new Set(['default', 'requiredEnvVars']), issues);
	const defaultValue = readDataProperty(value, 'default', issues, true, '$.flag');
	if (defaultValue !== undefined && typeof defaultValue !== 'boolean') {
		addIssue(issues, 'invalid_type', '$.flag.default', 'must be a boolean');
	}
	const requiredEnvVars = readDataProperty(value, 'requiredEnvVars', issues, false, '$.flag');
	if (requiredEnvVars === undefined) return;
	if (!Array.isArray(requiredEnvVars)) {
		addIssue(issues, 'invalid_type', '$.flag.requiredEnvVars', 'must be an array');
		return;
	}
	const seen = new Set<string>();
	for (const [index, envVar] of requiredEnvVars.entries()) {
		const path = `$.flag.requiredEnvVars[${index}]`;
		if (typeof envVar !== 'string') addIssue(issues, 'invalid_type', path, 'must be a string');
		else if (!ENV_VAR.test(envVar))
			addIssue(issues, 'invalid_format', path, 'must be an uppercase environment variable name');
		else if (seen.has(envVar))
			addIssue(issues, 'duplicate', path, `duplicates environment variable ${envVar}`);
		else seen.add(envVar);
	}
}

function validateLlmBudget(value: unknown, issues: PluginManifestIssue[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		addIssue(issues, 'invalid_type', '$.llmBudget', 'must be a plain object');
		return;
	}
	validateKnownFields(value, '$.llmBudget', new Set(['dailyUsd']), issues);
	const dailyUsd = readDataProperty(value, 'dailyUsd', issues, true, '$.llmBudget');
	if (
		dailyUsd !== undefined &&
		(typeof dailyUsd !== 'number' || !Number.isFinite(dailyUsd) || dailyUsd <= 0)
	) {
		addIssue(
			issues,
			'invalid_type',
			'$.llmBudget.dailyUsd',
			'must be a finite number greater than zero'
		);
	}
}

function validateKnownFields(
	value: Record<string, unknown>,
	path: string,
	knownFields: ReadonlySet<string>,
	issues: PluginManifestIssue[]
): void {
	for (const key of Object.keys(value)) {
		if (!knownFields.has(key))
			addIssue(issues, 'unknown_field', `${path}.${key}`, 'is not supported');
	}
}

function readDataProperty(
	value: Record<string, unknown>,
	key: string,
	issues: PluginManifestIssue[],
	required = false,
	parentPath = '$'
): unknown {
	const path = `${parentPath}.${key}`;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) {
		if (required) addIssue(issues, 'missing', path, 'is required');
		return undefined;
	}
	if (!('value' in descriptor)) {
		addIssue(issues, 'accessor_not_allowed', path, 'must be a data property');
		return undefined;
	}
	return descriptor.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function addIssue(
	issues: PluginManifestIssue[],
	code: PluginManifestIssueCode,
	path: string,
	message: string
): void {
	issues.push({ code, path, message });
}
