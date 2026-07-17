import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateKnownFields,
} from './manifestValue';
import { isSafeStaticExportPath } from './staticExportPath';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/**
 * The HMAC signing secret must live in a plugin-scoped `PLUGIN_`-prefixed env
 * var so a manifest can never designate an unrelated host secret (e.g.
 * `DATABASE_URL`, an admin token) as its signing key — which, once an HTTP
 * surface exists, would turn signature verification into an HMAC oracle over
 * that secret. `getPluginSecret` reads arbitrary keys, so this namespace is the
 * only barrier.
 */
const SECRET_ENV_VAR = /^PLUGIN_[A-Z0-9][A-Z0-9_]*$/;
const HEADER = /^[a-z0-9][a-z0-9-]*$/;
const FIELDS = new Set(['id', 'label', 'module', 'signature', 'attestSource']);
const SIGNATURE_FIELDS = new Set(['header', 'algorithm', 'encoding', 'secretEnvVar']);
const ALGORITHMS = new Set(['hmac-sha256', 'hmac-sha1']);
const ENCODINGS = new Set(['hex', 'base64']);
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
 */
function validateSignature(
	provider: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const signature = readDataProperty(provider, 'signature', issues, true, path);
	if (signature.kind !== 'value') return;
	if (!isRecord(signature.value)) {
		addManifestIssue(issues, 'invalid_type', `${path}.signature`, 'must be a plain object');
		return;
	}
	const signaturePath = `${path}.signature`;
	validateKnownFields(signature.value, signaturePath, SIGNATURE_FIELDS, issues);

	const header = readDataProperty(signature.value, 'header', issues, true, signaturePath);
	if (
		header.kind === 'value' &&
		(typeof header.value !== 'string' || header.value.length > 128 || !HEADER.test(header.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${signaturePath}.header`,
			'must be a lower-case HTTP header name'
		);
	}

	const algorithm = readDataProperty(signature.value, 'algorithm', issues, true, signaturePath);
	if (
		algorithm.kind === 'value' &&
		(typeof algorithm.value !== 'string' || !ALGORITHMS.has(algorithm.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${signaturePath}.algorithm`,
			'must be hmac-sha256 or hmac-sha1'
		);
	}

	const encoding = readDataProperty(signature.value, 'encoding', issues, true, signaturePath);
	if (
		encoding.kind === 'value' &&
		(typeof encoding.value !== 'string' || !ENCODINGS.has(encoding.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${signaturePath}.encoding`,
			'must be hex or base64'
		);
	}

	const secretEnvVar = readDataProperty(
		signature.value,
		'secretEnvVar',
		issues,
		true,
		signaturePath
	);
	if (
		secretEnvVar.kind === 'value' &&
		(typeof secretEnvVar.value !== 'string' ||
			secretEnvVar.value.length > 128 ||
			!SECRET_ENV_VAR.test(secretEnvVar.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${signaturePath}.secretEnvVar`,
			'must be a PLUGIN_-prefixed uppercase environment variable name'
		);
	}
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
