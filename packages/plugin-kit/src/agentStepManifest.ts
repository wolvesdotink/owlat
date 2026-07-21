import { isPluginLocalId } from './namespacedKind';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateDescriptorSafeArray,
	validateKnownFields,
} from './manifestValue';
import { isSafeStaticExportPath } from './staticExportPath';

const STEP_REFERENCE = /^(?:[a-z][a-z0-9_]*|plugin\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)$/;
const RESERVED_LOCAL_IDS = new Set(['constructor', 'prototype', '__proto__']);
const MAX_EDGES = 12;

export function validateAgentStepContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const seenIds = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `$.contributes.agentSteps[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
			continue;
		}
		validateKnownFields(
			item.value,
			path,
			new Set(['id', 'after', 'module', 'lifecycleEdges']),
			issues
		);
		validateId(item.value, path, seenIds, issues);
		validateReference(item.value, path, issues);
		validateModule(item.value, path, issues);
		validateEdges(item.value, path, issues);
	}
}

function validateId(
	step: Record<string, unknown>,
	path: string,
	seenIds: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const id = readDataProperty(step, 'id', issues, true, path);
	if (id.kind !== 'value') return;
	if (
		typeof id.value !== 'string' ||
		!isPluginLocalId(id.value) ||
		RESERVED_LOCAL_IDS.has(id.value)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.id`,
			'must be a non-reserved lowercase kebab-case id of at most 64 characters'
		);
	} else if (seenIds.has(id.value)) {
		addManifestIssue(issues, 'duplicate', `${path}.id`, `duplicates agent step ${id.value}`);
	} else {
		seenIds.add(id.value);
	}
}

function validateReference(
	step: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const after = readDataProperty(step, 'after', issues, true, path);
	if (
		after.kind === 'value' &&
		(typeof after.value !== 'string' ||
			after.value.length > 140 ||
			!STEP_REFERENCE.test(after.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.after`,
			'must name a core or namespaced plugin step'
		);
	}
}

function validateModule(
	step: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const module = readDataProperty(step, 'module', issues, true, path);
	if (module.kind !== 'value') return;
	if (!isRecord(module.value)) {
		addManifestIssue(issues, 'invalid_type', `${path}.module`, 'must be a plain object');
		return;
	}
	validateKnownFields(module.value, `${path}.module`, new Set(['exportPath']), issues);
	const exportPath = readDataProperty(module.value, 'exportPath', issues, true, `${path}.module`);
	if (
		exportPath.kind === 'value' &&
		(typeof exportPath.value !== 'string' || !isSafeStaticExportPath(exportPath.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.module.exportPath`,
			'must be a safe relative package export path'
		);
	}
}

function validateEdges(
	step: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const edges = readDataProperty(step, 'lifecycleEdges', issues, true, path);
	if (edges.kind !== 'value') return;
	const items = validateDescriptorSafeArray(edges.value, `${path}.lifecycleEdges`, issues);
	if (!items) return;
	if (items.length > MAX_EDGES) {
		addManifestIssue(
			issues,
			'too_many_items',
			`${path}.lifecycleEdges`,
			`must contain at most ${MAX_EDGES} edges`
		);
		return;
	}
	const seen = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const edgePath = `${path}.lifecycleEdges[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', edgePath, 'must be a plain object');
			continue;
		}
		validateKnownFields(item.value, edgePath, new Set(['kind', 'from', 'to']), issues);
		const kind = readEdgeField(item.value, 'kind', edgePath, issues);
		const from = readEdgeField(item.value, 'from', edgePath, issues);
		const to = readEdgeField(item.value, 'to', edgePath, issues);
		if (!kind || !from || !to) continue;
		if (!isRecognizedLifecycleEdge(kind, from, to)) {
			addManifestIssue(
				issues,
				'invalid_format',
				edgePath,
				'must be a supported caution or post-draft review edge'
			);
			continue;
		}
		const key = `${kind}:${from}->${to}`;
		if (seen.has(key)) {
			addManifestIssue(issues, 'duplicate', edgePath, `duplicates lifecycle edge ${key}`);
		} else {
			seen.add(key);
		}
	}
}

function readEdgeField(
	edge: Record<string, unknown>,
	field: 'kind' | 'from' | 'to',
	path: string,
	issues: PluginManifestIssue[]
): string | undefined {
	const value = readDataProperty(edge, field, issues, true, path);
	if (value.kind !== 'value') return undefined;
	if (typeof value.value !== 'string') {
		addManifestIssue(issues, 'invalid_type', `${path}.${field}`, 'must be a string');
		return undefined;
	}
	return value.value;
}

function isRecognizedLifecycleEdge(kind: string, from: string, to: string): boolean {
	if (kind === 'caution') {
		return (
			(from === 'classifying' || from === 'drafting') && (to === 'archived' || to === 'failed')
		);
	}
	return kind === 'draft_review' && from === 'drafting' && to === 'draft_ready';
}
