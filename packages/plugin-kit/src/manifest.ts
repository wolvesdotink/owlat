import type { PluginCapability } from './capabilities';
import { isPluginContributionKind, type PluginContributions } from './contributions';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import { snapshotManifestInput } from './manifestSnapshot';
import { isPluginId, type PluginId } from './pluginId';
import { PLUGIN_SEND_TRANSPORT_CAPABILITY } from './sendTransport';
import { validateSendTransportContributions } from './sendTransportManifest';
import { isSafeStaticExportPath } from './staticExportPath';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateDescriptorSafeArray,
	validateKnownFields,
} from './manifestValue';

export { PLUGIN_CONTRIBUTION_KINDS } from './contributions';
export type { PluginContributionKind, PluginContributions } from './contributions';
export type { PluginManifestIssue, PluginManifestIssueCode } from './manifestIssues';

export interface PluginFeatureFlagDefinition {
	readonly default: boolean;
	readonly requiredEnvVars?: readonly string[];
}

export interface PluginLlmBudget {
	readonly dailyUsd: number;
}

/** A statically importable Convex component package export. */
export interface PluginComponentDefinition {
	/** Exact condition-independent package export, for example `./convex/convex.config`. */
	readonly exportPath: string;
}

export interface PluginManifest {
	readonly id: PluginId;
	readonly version: string;
	readonly capabilities: readonly PluginCapability[];
	readonly contributes?: PluginContributions;
	readonly flag?: PluginFeatureFlagDefinition;
	readonly llmBudget?: PluginLlmBudget;
	readonly component?: PluginComponentDefinition;
}

export type PluginManifestValidation =
	| { readonly ok: true; readonly manifest: PluginManifest }
	| { readonly ok: false; readonly issues: readonly PluginManifestIssue[] };

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

type PluginManifestDefinition = Omit<PluginManifest, 'id'> & { readonly id: string };

export function definePlugin<const TManifest extends PluginManifestDefinition>(
	manifest: TManifest
): TManifest & PluginManifest {
	parsePluginManifest(manifest);
	return manifest as TManifest & PluginManifest;
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
	const manifest = snapshotManifestInput(value, issues);
	if (!isRecord(manifest)) {
		addManifestIssue(issues, 'invalid_type', '$', 'must be a plain object');
		return { ok: false, issues };
	}

	validateKnownFields(manifest, '$', TOP_LEVEL_FIELDS, issues);

	const id = readDataProperty(manifest, 'id', issues, true);
	if (id.kind === 'value' && typeof id.value === 'string') {
		if (!isPluginId(id.value)) {
			addManifestIssue(
				issues,
				'invalid_format',
				'$.id',
				'must be a lowercase kebab-case id of at most 64 characters'
			);
		}
	} else if (id.kind === 'value') {
		addManifestIssue(issues, 'invalid_type', '$.id', 'must be a string');
	}

	const version = readDataProperty(manifest, 'version', issues, true);
	if (version.kind === 'value' && typeof version.value === 'string') {
		if (!SEMVER.test(version.value))
			addManifestIssue(issues, 'invalid_format', '$.version', 'must be a semantic version');
	} else if (version.kind === 'value') {
		addManifestIssue(issues, 'invalid_type', '$.version', 'must be a string');
	}

	const capabilities = readDataProperty(manifest, 'capabilities', issues, true);
	const capabilityItems =
		capabilities.kind === 'value' ? validateCapabilities(capabilities.value, issues) : undefined;
	const contributions = readDataProperty(manifest, 'contributes', issues);
	if (contributions.kind === 'value') validateContributions(contributions.value, issues);
	const flag = readDataProperty(manifest, 'flag', issues);
	const flagIssueCount = issues.length;
	if (flag.kind === 'value') validateFlag(flag.value, issues);
	const hasValidFlag =
		flag.kind === 'value' && isRecord(flag.value) && issues.length === flagIssueCount;
	if (declaresPluginStorage(capabilityItems) && !hasValidFlag) {
		if (flag.kind === 'missing') {
			addManifestIssue(
				issues,
				'missing',
				'$.flag',
				'is required when plugin storage capabilities are declared'
			);
		} else if (flag.kind === 'value' && flag.value === undefined) {
			addManifestIssue(
				issues,
				'invalid_type',
				'$.flag',
				'must be a plain object when plugin storage capabilities are declared'
			);
		}
	}
	const llmBudget = readDataProperty(manifest, 'llmBudget', issues);
	const llmBudgetIssueCount = issues.length;
	if (llmBudget.kind === 'value') validateLlmBudget(llmBudget.value, issues);
	const hasValidLlmBudget =
		llmBudget.kind === 'value' &&
		isRecord(llmBudget.value) &&
		issues.length === llmBudgetIssueCount;
	if (declaresLlmInvoke(capabilityItems)) {
		if (!hasValidFlag && !issues.some((issue) => issue.path.startsWith('$.flag'))) {
			addManifestIssue(
				issues,
				flag.kind === 'missing' ? 'missing' : 'invalid_type',
				'$.flag',
				'must be a plain object when llm:invoke is declared'
			);
		}
		if (!hasValidLlmBudget && !issues.some((issue) => issue.path.startsWith('$.llmBudget'))) {
			addManifestIssue(
				issues,
				llmBudget.kind === 'missing' ? 'missing' : 'invalid_type',
				'$.llmBudget',
				'must be a valid daily budget when llm:invoke is declared'
			);
		}
	}
	if (declaresSendTransports(manifest)) {
		if (!declaresCapability(capabilityItems, PLUGIN_SEND_TRANSPORT_CAPABILITY)) {
			addManifestIssue(
				issues,
				'missing',
				'$.capabilities',
				`must declare ${PLUGIN_SEND_TRANSPORT_CAPABILITY} when send transports are contributed`
			);
		}
		if (!hasValidFlag && !issues.some((issue) => issue.path.startsWith('$.flag'))) {
			addManifestIssue(
				issues,
				flag.kind === 'missing' ? 'missing' : 'invalid_type',
				'$.flag',
				'must be a plain object when send transports are contributed'
			);
		}
	}

	const component = readDataProperty(manifest, 'component', issues);
	if (component.kind === 'value') validateComponent(component.value, issues);

	return issues.length === 0
		? { ok: true, manifest: manifest as unknown as PluginManifest }
		: { ok: false, issues };
}

function validateComponent(value: unknown, issues: PluginManifestIssue[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		addManifestIssue(issues, 'invalid_type', '$.component', 'must be a plain object');
		return;
	}
	validateKnownFields(value, '$.component', new Set(['exportPath']), issues);
	const exportPath = readDataProperty(value, 'exportPath', issues, true, '$.component');
	if (exportPath.kind !== 'value') return;
	if (typeof exportPath.value !== 'string' || !isSafeStaticExportPath(exportPath.value)) {
		addManifestIssue(
			issues,
			'invalid_format',
			'$.component.exportPath',
			'must be a safe relative package export path'
		);
	}
}

function validateCapabilities(
	value: unknown,
	issues: PluginManifestIssue[]
): readonly DataProperty[] | undefined {
	return validateUniqueFormattedStringArray(value, issues, {
		path: '$.capabilities',
		format: CAPABILITY,
		formatMessage: 'must use the lowercase domain:action form',
		duplicateLabel: 'capability',
	});
}

function declaresPluginStorage(items: readonly DataProperty[] | undefined): boolean {
	return (
		items?.some(
			(item) =>
				item.kind === 'value' &&
				(item.value === 'plugin-storage:read' || item.value === 'plugin-storage:write')
		) ?? false
	);
}

function declaresLlmInvoke(items: readonly DataProperty[] | undefined): boolean {
	return declaresCapability(items, 'llm:invoke');
}

function declaresCapability(
	items: readonly DataProperty[] | undefined,
	capability: string
): boolean {
	return items?.some((item) => item.kind === 'value' && item.value === capability) ?? false;
}

function declaresSendTransports(manifest: Record<string, unknown>): boolean {
	const contributes = Object.getOwnPropertyDescriptor(manifest, 'contributes');
	if (!contributes || !('value' in contributes) || !isRecord(contributes.value)) return false;
	const transports = Object.getOwnPropertyDescriptor(contributes.value, 'sendTransports');
	return Boolean(
		transports &&
		'value' in transports &&
		Array.isArray(transports.value) &&
		transports.value.length > 0
	);
}

function validateContributions(value: unknown, issues: PluginManifestIssue[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		addManifestIssue(issues, 'invalid_type', '$.contributes', 'must be a plain object');
		return;
	}
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string') {
			addManifestIssue(
				issues,
				'unknown_field',
				`$.contributes[${String(key)}]`,
				'symbol fields are not supported'
			);
			continue;
		}
		const path = `$.contributes.${key}`;
		if (!isPluginContributionKind(key)) {
			addManifestIssue(issues, 'unknown_field', path, 'is not a known contribution kind');
			continue;
		}
		const contribution = readDataProperty(value, key, issues);
		if (contribution.kind === 'value') {
			const items = validateDescriptorSafeArray(contribution.value, path, issues);
			if (key === 'sendTransports' && items) validateSendTransportContributions(items, issues);
		}
	}
}

function validateFlag(value: unknown, issues: PluginManifestIssue[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		addManifestIssue(issues, 'invalid_type', '$.flag', 'must be a plain object');
		return;
	}
	validateKnownFields(value, '$.flag', new Set(['default', 'requiredEnvVars']), issues);
	const defaultValue = readDataProperty(value, 'default', issues, true, '$.flag');
	if (defaultValue.kind === 'value' && typeof defaultValue.value !== 'boolean') {
		addManifestIssue(issues, 'invalid_type', '$.flag.default', 'must be a boolean');
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
		addManifestIssue(issues, 'invalid_type', '$.llmBudget', 'must be a plain object');
		return;
	}
	validateKnownFields(value, '$.llmBudget', new Set(['dailyUsd']), issues);
	const dailyUsd = readDataProperty(value, 'dailyUsd', issues, true, '$.llmBudget');
	if (
		dailyUsd.kind === 'value' &&
		(typeof dailyUsd.value !== 'number' ||
			!Number.isFinite(dailyUsd.value) ||
			dailyUsd.value <= 0 ||
			dailyUsd.value > 1_000_000 ||
			!Number.isSafeInteger(dailyUsd.value * 1_000_000))
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			'$.llmBudget.dailyUsd',
			'must be between 0 and 1,000,000 USD with at most six decimal places'
		);
	}
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
): readonly DataProperty[] | undefined {
	const items = validateDescriptorSafeArray(value, options.path, issues);
	if (!items) return undefined;

	const seen = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `${options.path}[${index}]`;
		if (typeof item.value !== 'string') {
			addManifestIssue(issues, 'invalid_type', path, 'must be a string');
		} else if (!options.format.test(item.value)) {
			addManifestIssue(issues, 'invalid_format', path, options.formatMessage);
		} else if (seen.has(item.value)) {
			addManifestIssue(
				issues,
				'duplicate',
				path,
				`duplicates ${options.duplicateLabel} ${item.value}`
			);
		} else {
			seen.add(item.value);
		}
	}
	return items;
}
