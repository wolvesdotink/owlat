import { isPluginContributionKind } from './contributions';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';

// Manifests are static declarations: these limits leave ample composition room
// while bounding validation work at the public `unknown` input boundary.
const MAX_CAPABILITIES = 64;
const MAX_REQUIRED_ENV_VARS = 64;
const MAX_CONTRIBUTIONS_PER_KIND = 256;
const MAX_ARRAY_LENGTH = 0xffff_ffff;
export const INVALID_SCHEMA_ARRAY = Object.freeze({ invalidSchemaArray: true });

type SnapshotDataValue = (key: PropertyKey, value: unknown) => unknown;

/** Capture every schema-owned input descriptor once before validating the immutable result. */
export function snapshotManifestInput(value: unknown, issues: PluginManifestIssue[]): unknown {
	return snapshotRecord(value, (key, propertyValue) => {
		switch (key) {
			case 'capabilities':
				return snapshotArray(propertyValue, '$.capabilities', MAX_CAPABILITIES, issues);
			case 'contributes':
				return snapshotContributions(propertyValue, issues);
			case 'flag':
				return snapshotFlag(propertyValue, issues);
			case 'llmBudget':
				return snapshotRecord(propertyValue);
			case 'component':
				return snapshotRecord(propertyValue);
			default:
				return propertyValue;
		}
	});
}

function snapshotContributions(value: unknown, issues: PluginManifestIssue[]): unknown {
	return snapshotRecord(value, (key, propertyValue) => {
		if (typeof key !== 'string' || !isPluginContributionKind(key)) return propertyValue;
		const path = `$.contributes.${key}`;
		return snapshotArray(
			propertyValue,
			path,
			MAX_CONTRIBUTIONS_PER_KIND,
			issues,
			key === 'sendTransports' ||
				key === 'agentSteps' ||
				key === 'draftStrategies' ||
				key === 'sendGates' ||
				key === 'automationTriggers' ||
				key === 'automationSteps' ||
				key === 'automationConditions' ||
				key === 'crons'
				? (item, index) =>
						snapshotRecord(item, (field, fieldValue) =>
							field === 'module' || field === 'schedule'
								? snapshotRecord(fieldValue)
								: field === 'retryDelays'
									? snapshotArray(fieldValue, `${path}[${index}].retryDelays`, 3, issues)
									: field === 'lifecycleEdges'
										? snapshotArray(
												fieldValue,
												`${path}[${index}].lifecycleEdges`,
												12,
												issues,
												(edge) => snapshotRecord(edge)
											)
										: fieldValue
						)
				: undefined
		);
	});
}

function snapshotFlag(value: unknown, issues: PluginManifestIssue[]): unknown {
	return snapshotRecord(value, (key, propertyValue) =>
		key === 'requiredEnvVars'
			? snapshotArray(propertyValue, '$.flag.requiredEnvVars', MAX_REQUIRED_ENV_VARS, issues)
			: propertyValue
	);
}

function snapshotRecord(value: unknown, snapshotDataValue?: SnapshotDataValue): unknown {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;

	const descriptors = captureOwnPropertyDescriptors(value);
	const snapshot = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
	for (const [key, descriptor] of descriptors) {
		Object.defineProperty(
			snapshot,
			key,
			'value' in descriptor && snapshotDataValue
				? { ...descriptor, value: snapshotDataValue(key, descriptor.value) }
				: descriptor
		);
	}
	return Object.freeze(snapshot);
}

function snapshotArray(
	value: unknown,
	path: string,
	maximumItems: number,
	issues: PluginManifestIssue[],
	snapshotItem?: (value: unknown, index: number) => unknown
): unknown {
	if (!Array.isArray(value)) return value;

	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	if (!lengthDescriptor) {
		addManifestIssue(issues, 'missing', `${path}.length`, 'is required');
		return INVALID_SCHEMA_ARRAY;
	}
	if (!('value' in lengthDescriptor)) {
		addManifestIssue(issues, 'accessor_not_allowed', `${path}.length`, 'must be a data property');
		return INVALID_SCHEMA_ARRAY;
	}
	const length = lengthDescriptor.value;
	if (
		typeof length !== 'number' ||
		!Number.isInteger(length) ||
		length < 0 ||
		length > MAX_ARRAY_LENGTH
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.length`,
			'must be an unsigned 32-bit integer'
		);
		return INVALID_SCHEMA_ARRAY;
	}
	if (length > maximumItems) {
		addManifestIssue(issues, 'too_many_items', path, `must contain at most ${maximumItems} items`);
		return INVALID_SCHEMA_ARRAY;
	}

	const snapshot: unknown[] = [];
	snapshot.length = length;
	let reportedOutOfRangeIndex = false;
	for (const key of Reflect.ownKeys(value)) {
		if (key === 'length') continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		if (typeof key === 'string' && isArrayIndexAtOrBeyondLength(key, length)) {
			if (!reportedOutOfRangeIndex) {
				addManifestIssue(
					issues,
					'unknown_field',
					`${path}[${key}]`,
					'is outside the declared array length'
				);
				reportedOutOfRangeIndex = true;
			}
			continue;
		}
		const arrayIndex = typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : null;
		Object.defineProperty(
			snapshot,
			key,
			arrayIndex !== null && 'value' in descriptor && snapshotItem
				? { ...descriptor, value: snapshotItem(descriptor.value, arrayIndex) }
				: descriptor
		);
	}
	return Object.freeze(snapshot);
}

function isArrayIndexAtOrBeyondLength(key: string, length: number): boolean {
	if (!/^(0|[1-9]\d*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isInteger(index) && index < MAX_ARRAY_LENGTH && index >= length;
}

function captureOwnPropertyDescriptors(
	value: object
): readonly (readonly [PropertyKey, PropertyDescriptor])[] {
	const descriptors: Array<readonly [PropertyKey, PropertyDescriptor]> = [];
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor) descriptors.push([key, descriptor]);
	}
	return descriptors;
}
