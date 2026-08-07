import { validateInboundSignatureContract } from './inboundSignatureManifest';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateKnownFields,
} from './manifestValue';
import { isSafeStaticExportPath } from './staticExportPath';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FIELDS = new Set(['id', 'label', 'module', 'signature', 'attestSource']);
const RESERVED_LOCAL_IDS = new Set(['constructor', 'prototype', '__proto__']);

export function validateImportProviderContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `$.contributes.importProviders[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
			continue;
		}
		validateKnownFields(item.value, path, FIELDS, issues);
		validateId(item.value, path, ids, issues);
		validateLabel(item.value, path, issues);
		validateModule(item.value, path, issues);
		validateSignature(item.value, path, issues);
		validateAttestSource(item.value, path, issues);
	}
}

function validateId(
	provider: Record<string, unknown>,
	path: string,
	ids: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const id = readDataProperty(provider, 'id', issues, true, path);
	if (id.kind !== 'value') return;
	if (
		typeof id.value !== 'string' ||
		id.value.length > 64 ||
		!ID.test(id.value) ||
		RESERVED_LOCAL_IDS.has(id.value)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.id`,
			'must be a non-reserved lowercase kebab-case id of at most 64 characters'
		);
	} else if (ids.has(id.value)) {
		addManifestIssue(issues, 'duplicate', `${path}.id`, `duplicates import provider ${id.value}`);
	} else {
		ids.add(id.value);
	}
}

function validateLabel(
	provider: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const label = readDataProperty(provider, 'label', issues, true, path);
	if (
		label.kind === 'value' &&
		(typeof label.value !== 'string' || label.value.trim().length < 1 || label.value.length > 100)
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.label`,
			'must be a non-empty string of at most 100 characters'
		);
	}
}

function validateModule(
	provider: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const module = readDataProperty(provider, 'module', issues, true, path);
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

/**
 * The inbound signature-verification contract is mandatory: a plugin that
 * sources events into Owlat must declare how the host verifies their
 * authenticity before any plugin-produced data is trusted.
 *
 * `replay: 'forbidden'` — the field rules are shared with the send-transport
 * feedback webhook (`./inboundSignatureManifest.ts`), and the one difference is
 * that no HTTP surface dispatches import-provider callbacks yet. Accepting
 * replay provisions here would let a manifest declare a defense the host never
 * runs; the piece that opens that surface flips this to `'required'`.
 */
function validateSignature(
	provider: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const signature = readDataProperty(provider, 'signature', issues, true, path);
	if (signature.kind !== 'value') return;
	validateInboundSignatureContract(signature.value, `${path}.signature`, 'forbidden', issues);
}

function validateAttestSource(
	provider: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const attestSource = readDataProperty(provider, 'attestSource', issues, false, path);
	if (
		attestSource.kind === 'value' &&
		(typeof attestSource.value !== 'string' ||
			attestSource.value.trim().length < 1 ||
			attestSource.value.length > 64)
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.attestSource`,
			'must be a non-empty string of at most 64 characters'
		);
	}
}
