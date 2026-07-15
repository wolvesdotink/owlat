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
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CAPABILITY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*:[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
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

	validateKnownFields(value, '$', TOP_LEVEL_FIELDS, issues);

	const id = readDataProperty(value, 'id', issues, true);
	if (id.kind === 'value' && typeof id.value === 'string') {
		if (id.value.length > 64 || !PLUGIN_ID.test(id.value)) {
			addIssue(
				issues,
				'invalid_format',
				'$.id',
				'must be a lowercase kebab-case id of at most 64 characters'
			);
		}
	} else if (id.kind === 'value') {
		addIssue(issues, 'invalid_type', '$.id', 'must be a string');
	}

	const version = readDataProperty(value, 'version', issues, true);
	if (version.kind === 'value' && typeof version.value === 'string') {
		if (!SEMVER.test(version.value))
			addIssue(issues, 'invalid_format', '$.version', 'must be a semantic version');
	} else if (version.kind === 'value') {
		addIssue(issues, 'invalid_type', '$.version', 'must be a string');
	}

	const capabilities = readDataProperty(value, 'capabilities', issues, true);
	if (capabilities.kind === 'value') validateCapabilities(capabilities.value, issues);
	const contributions = readDataProperty(value, 'contributes', issues);
	if (contributions.kind === 'value') validateContributions(contributions.value, issues);
	const flag = readDataProperty(value, 'flag', issues);
	if (flag.kind === 'value') validateFlag(flag.value, issues);
	const llmBudget = readDataProperty(value, 'llmBudget', issues);
	if (llmBudget.kind === 'value') validateLlmBudget(llmBudget.value, issues);

	const component = readDataProperty(value, 'component', issues);
	if (
		component.kind === 'value' &&
		component.value !== undefined &&
		typeof component.value !== 'function'
	) {
		addIssue(issues, 'invalid_type', '$.component', 'must be an async component loader');
	}

	return issues.length === 0
		? { ok: true, manifest: value as unknown as PluginManifest }
		: { ok: false, issues };
}

function validateCapabilities(value: unknown, issues: PluginManifestIssue[]): void {
	validateUniqueFormattedStringArray(value, issues, {
		path: '$.capabilities',
		format: CAPABILITY,
		formatMessage: 'must use the lowercase domain:action form',
		duplicateLabel: 'capability',
	});
}

function validateContributions(value: unknown, issues: PluginManifestIssue[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		addIssue(issues, 'invalid_type', '$.contributes', 'must be a plain object');
		return;
	}
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string') {
			addIssue(
				issues,
				'unknown_field',
				`$.contributes[${String(key)}]`,
				'symbol fields are not supported'
			);
			continue;
		}
		const path = `$.contributes.${key}`;
		if (!CONTRIBUTION_KINDS.has(key)) {
			addIssue(issues, 'unknown_field', path, 'is not a known contribution kind');
			continue;
		}
		const contribution = readDataProperty(value, key, issues);
		if (contribution.kind === 'value') {
			validateDescriptorSafeArray(contribution.value, path, issues);
		}
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
	if (defaultValue.kind === 'value' && typeof defaultValue.value !== 'boolean') {
		addIssue(issues, 'invalid_type', '$.flag.default', 'must be a boolean');
	}
	const requiredEnvVars = readDataProperty(value, 'requiredEnvVars', issues, false, '$.flag');
	if (requiredEnvVars.kind === 'value') {
		validateUniqueFormattedStringArray(requiredEnvVars.value, issues, {
			path: '$.flag.requiredEnvVars',
			format: ENV_VAR,
			formatMessage: 'must be an uppercase environment variable name',
			duplicateLabel: 'environment variable',
		});
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
		dailyUsd.kind === 'value' &&
		(typeof dailyUsd.value !== 'number' || !Number.isFinite(dailyUsd.value) || dailyUsd.value <= 0)
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
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string') {
			addIssue(
				issues,
				'unknown_field',
				`${path}[${String(key)}]`,
				'symbol fields are not supported'
			);
		} else if (!knownFields.has(key)) {
			addIssue(issues, 'unknown_field', `${path}.${key}`, 'is not supported');
		}
	}
}

type DataProperty =
	| { readonly kind: 'missing' | 'accessor' }
	| { readonly kind: 'value'; readonly value: unknown };

function readDataProperty(
	value: Record<string, unknown>,
	key: string,
	issues: PluginManifestIssue[],
	required = false,
	parentPath = '$'
): DataProperty {
	const path = /^(0|[1-9]\d*)$/.test(key) ? `${parentPath}[${key}]` : `${parentPath}.${key}`;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) {
		if (required) addIssue(issues, 'missing', path, 'is required');
		return { kind: 'missing' };
	}
	if (!('value' in descriptor)) {
		addIssue(issues, 'accessor_not_allowed', path, 'must be a data property');
		return { kind: 'accessor' };
	}
	return { kind: 'value', value: descriptor.value };
}

interface FormattedStringArrayOptions {
	readonly path: string;
	readonly format: RegExp;
	readonly formatMessage: string;
	readonly duplicateLabel: string;
}

function validateUniqueFormattedStringArray(
	value: unknown,
	issues: PluginManifestIssue[],
	options: FormattedStringArrayOptions
): void {
	const items = validateDescriptorSafeArray(value, options.path, issues);
	if (!items) return;

	const seen = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `${options.path}[${index}]`;
		if (typeof item.value !== 'string') {
			addIssue(issues, 'invalid_type', path, 'must be a string');
		} else if (!options.format.test(item.value)) {
			addIssue(issues, 'invalid_format', path, options.formatMessage);
		} else if (seen.has(item.value)) {
			addIssue(issues, 'duplicate', path, `duplicates ${options.duplicateLabel} ${item.value}`);
		} else {
			seen.add(item.value);
		}
	}
}

function validateDescriptorSafeArray(
	value: unknown,
	path: string,
	issues: PluginManifestIssue[]
): readonly DataProperty[] | undefined {
	if (!Array.isArray(value)) {
		addIssue(issues, 'invalid_type', path, 'must be an array');
		return undefined;
	}
	const length = readDataProperty(
		value as unknown as Record<string, unknown>,
		'length',
		issues,
		true,
		path
	);
	if (
		length.kind !== 'value' ||
		typeof length.value !== 'number' ||
		!Number.isSafeInteger(length.value) ||
		length.value < 0
	) {
		if (length.kind === 'value') {
			addIssue(issues, 'invalid_type', `${path}.length`, 'must be a valid array length');
		}
		return undefined;
	}

	const allowedKeys = new Set<string>(['length']);
	for (let index = 0; index < length.value; index += 1) allowedKeys.add(String(index));
	validateKnownFields(value as unknown as Record<string, unknown>, path, allowedKeys, issues);

	const items: DataProperty[] = [];
	for (let index = 0; index < length.value; index += 1) {
		items.push(
			readDataProperty(
				value as unknown as Record<string, unknown>,
				String(index),
				issues,
				true,
				path
			)
		);
	}
	return items;
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
