import { validateInboundSignatureContract } from './inboundSignatureManifest';
import { isPluginLocalId } from './namespacedKind';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateDescriptorSafeArray,
	validateKnownFields,
} from './manifestValue';
import { isPluginSendTransportEnvVar, PLUGIN_SEND_TRANSPORT_MAX_ENV_VARS } from './sendTransport';
import { validateCredentialFields } from './sendTransportCredentialsManifest';
import { isSafeStaticExportPath } from './staticExportPath';

const RESERVED_LOCAL_IDS = new Set(['constructor', 'prototype', '__proto__']);
const MAX_LABEL_LENGTH = 80;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_TOTAL_DELAY_MS = 120_000;

/** One accepted configuration variable, and the list it was declared in. */
export interface SendTransportConfigEnvVar {
	readonly name: string;
	/** The manifest path of the LIST, which is what an issue about it points at. */
	readonly path: string;
}

/**
 * What this validator saw that a rule OUTSIDE `$.contributes` has to judge.
 *
 * Two facts, and they pull in opposite directions against the same list — which
 * is why both leave here rather than being decided locally:
 *
 *  - `webhookSecretEnvVars` MUST appear in `$.flag.requiredEnvVars` (an unset
 *    signing secret refuses every delivery, so the plugin must not be enableable
 *    without it);
 *  - `configEnvVars` must NOT (a flag variable is a deployment-wide switch read
 *    unsuffixed, a transport variable is read per instance under `__<KEY>`).
 *
 * `validatePluginManifest` owns both joins, because the flag lives at the top of
 * the manifest and this validator only ever sees one bucket.
 */
export interface SendTransportContributionFacts {
	readonly webhookSecretEnvVars: readonly string[];
	readonly configEnvVars: readonly SendTransportConfigEnvVar[];
}

/** Validate the bucket, and report back the two facts a top-level rule judges. */
export function validateSendTransportContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): SendTransportContributionFacts {
	const seenIds = new Set<string>();
	const webhookSecretEnvVars: string[] = [];
	const configEnvVars: SendTransportConfigEnvVar[] = [];
	let webhookDeclaredAt: number | null = null;
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `$.contributes.sendTransports[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
			continue;
		}
		validateKnownFields(
			item.value,
			path,
			new Set([
				'id',
				'label',
				'module',
				'retryDelays',
				'requiredEnvVars',
				'optionalEnvVars',
				'credentialFields',
				'supportsCustomReturnPath',
				'messageIdSource',
				'deduplicatesOnIdempotencyKey',
				'webhook',
				'domainIdentity',
			]),
			issues
		);
		validateId(item.value, path, seenIds, issues);
		validateLabel(item.value, path, issues);
		validateModule(item.value, path, issues);
		validateRetryDelays(item.value, path, issues);
		const declaredEnvVars = validateConfigEnvVars(item.value, path, issues);
		for (const field of CONFIG_ENV_VAR_FIELDS) {
			for (const name of declaredEnvVars[field]) {
				configEnvVars.push({ name, path: `${path}.${field}` });
			}
		}
		validateCredentialFields(item.value, path, declaredEnvVars, issues);
		validateCapabilities(item.value, path, issues);
		validateDomainIdentity(item.value, path, declaredEnvVars, issues);
		if (validateWebhook(item.value, path, issues, webhookSecretEnvVars)) {
			if (webhookDeclaredAt !== null) {
				// The feedback route is `/webhooks/plugin/<pluginId>` (D6): a plugin id
				// addresses exactly one inbound adapter, so a second declaration is a
				// contribution no request could ever reach. Rejected at manifest time
				// rather than resolved by an arbitrary rule at dispatch time.
				addManifestIssue(
					issues,
					'duplicate',
					`${path}.webhook`,
					`duplicates the feedback webhook already declared at $.contributes.sendTransports[${webhookDeclaredAt}] — one plugin has one webhook route`
				);
			} else {
				webhookDeclaredAt = index;
			}
		}
	}
	return { webhookSecretEnvVars, configEnvVars };
}

function validateId(
	transport: Record<string, unknown>,
	path: string,
	seenIds: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const id = readDataProperty(transport, 'id', issues, true, path);
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
		addManifestIssue(issues, 'duplicate', `${path}.id`, `duplicates transport ${id.value}`);
	} else {
		seenIds.add(id.value);
	}
}

function validateLabel(
	transport: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const label = readDataProperty(transport, 'label', issues, true, path);
	if (
		label.kind === 'value' &&
		(typeof label.value !== 'string' ||
			label.value.trim() !== label.value ||
			label.value.length < 1 ||
			label.value.length > MAX_LABEL_LENGTH)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.label`,
			`must be a trimmed label of at most ${MAX_LABEL_LENGTH} characters`
		);
	}
}

function validateModule(
	transport: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const module = readDataProperty(transport, 'module', issues, true, path);
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
 * Validate an optional feedback webhook. Returns whether one was DECLARED (as
 * opposed to well-formed), because the one-per-plugin rule must count a
 * malformed declaration too — otherwise dropping a required field would be a way
 * to smuggle a second webhook past the count.
 */
function validateWebhook(
	transport: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[],
	webhookSecretEnvVars: string[]
): boolean {
	const webhook = readDataProperty(transport, 'webhook', issues, false, path);
	if (webhook.kind === 'missing') return false;
	const webhookPath = `${path}.webhook`;
	// An accessor has already been reported by `readDataProperty` and its value is
	// deliberately never evaluated; it still counts as a declaration.
	if (webhook.kind !== 'value') return true;
	if (!isRecord(webhook.value)) {
		addManifestIssue(issues, 'invalid_type', webhookPath, 'must be a plain object');
		return true;
	}
	validateKnownFields(
		webhook.value,
		webhookPath,
		new Set(['module', 'signature', 'storeRawPayload']),
		issues
	);
	validateModule(webhook.value, webhookPath, issues);

	// REQUIRED, and this is the piece's security floor: the route it feeds is
	// unauthenticated and internet-facing, so a webhook whose authenticity nobody
	// checks would be an open write path into the delivery record. `readDataProperty`
	// with `required` raises the missing-field issue itself.
	const signature = readDataProperty(webhook.value, 'signature', issues, true, webhookPath);
	if (signature.kind === 'value') {
		const secretEnvVar = validateInboundSignatureContract(
			signature.value,
			`${webhookPath}.signature`,
			'required',
			issues
		);
		if (secretEnvVar !== undefined) webhookSecretEnvVars.push(secretEnvVar);
	}

	const storeRawPayload = readDataProperty(
		webhook.value,
		'storeRawPayload',
		issues,
		false,
		webhookPath
	);
	if (storeRawPayload.kind === 'value' && typeof storeRawPayload.value !== 'boolean') {
		addManifestIssue(issues, 'invalid_type', `${webhookPath}.storeRawPayload`, 'must be a boolean');
	}
	return true;
}

/**
 * The transport's OWN configuration variables (the seams plan's P3.1), reported
 * back as the two accepted sets so the credential form can be joined to them.
 *
 * Both lists are validated as ONE namespace: a name may appear in exactly one of
 * them, because a variable cannot be both the presence gate and a refinement the
 * deployment may skip, and the host resolves the two lists into one record.
 *
 * The naming rule is {@link isPluginSendTransportEnvVar} — the kit's own
 * predicate, so the rule the validator enforces and the rule the host re-asserts
 * on the generated artifact cannot drift apart.
 */
function validateConfigEnvVars(
	transport: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): DeclaredConfigEnvVars {
	const declared = new Set<string>();
	const accepted: Record<ConfigEnvVarField, Set<string>> = {
		requiredEnvVars: new Set(),
		optionalEnvVars: new Set(),
	};
	let total = 0;
	for (const field of CONFIG_ENV_VAR_FIELDS) {
		const property = readDataProperty(transport, field, issues, false, path);
		if (property.kind !== 'value') continue;
		const items = validateDescriptorSafeArray(property.value, `${path}.${field}`, issues);
		if (!items) continue;
		total += items.length;
		for (const [index, item] of items.entries()) {
			if (item.kind !== 'value') continue;
			const itemPath = `${path}.${field}[${index}]`;
			if (!isPluginSendTransportEnvVar(item.value)) {
				addManifestIssue(
					issues,
					'invalid_format',
					itemPath,
					'must be a PLUGIN_-prefixed uppercase environment variable name without "__"'
				);
				continue;
			}
			if (declared.has(item.value)) {
				addManifestIssue(
					issues,
					'duplicate',
					itemPath,
					`duplicates environment variable ${item.value}`
				);
				continue;
			}
			declared.add(item.value);
			accepted[field].add(item.value);
		}
	}
	if (total > PLUGIN_SEND_TRANSPORT_MAX_ENV_VARS) {
		addManifestIssue(
			issues,
			'too_many_items',
			path,
			`must declare at most ${PLUGIN_SEND_TRANSPORT_MAX_ENV_VARS} configuration variables`
		);
	}
	// AN OPTIONAL-ONLY DECLARATION IS REFUSED, not quietly accepted. Declaring
	// configuration is what makes a transport instance-scoped, and an instance is
	// resolved by asking which of its REQUIRED variables are present under the
	// `__<INSTANCEKEY>` suffix. With none, every named instance of the kind would
	// be graded against an empty requirement list — vacuously configured on one
	// side, refused as `revoked` on the other — while the send went out on the
	// default instance's credentials. Saying so here is the only place an author
	// finds out; the two downstream answers are both wrong and neither is theirs
	// to read.
	if (accepted.requiredEnvVars.size === 0 && accepted.optionalEnvVars.size > 0) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.optionalEnvVars`,
			'must accompany at least one requiredEnvVars entry — a transport whose whole ' +
				'configuration is optional has no per-instance credential to resolve'
		);
	}
	return accepted;
}

const CONFIG_ENV_VAR_FIELDS = ['requiredEnvVars', 'optionalEnvVars'] as const;
/** Which of the two lists a variable was declared in. */
export type ConfigEnvVarField = (typeof CONFIG_ENV_VAR_FIELDS)[number];
/** The names each list ACCEPTED — a rejected name joins nothing. */
export type DeclaredConfigEnvVars = Readonly<Record<ConfigEnvVarField, ReadonlySet<string>>>;

/**
 * Validate an optional sending-domain identity (the seams plan's P3.2).
 *
 * Two rules, and the second is the one an author will not expect.
 *
 * THE SHAPE. One field, `module`, held to the same export-path rules as every
 * other executable half — codegen provenance-verifies it and imports it into
 * generated Convex code, so a path it cannot resolve must be refused here rather
 * than at build time.
 *
 * THE JOIN TO CONFIGURATION. A domain-identity module is called with
 * {@link PluginSendTransportConfig} — the values of THIS TRANSPORT's own declared
 * variables, and nothing else. The plugin's deployment-wide `flag.requiredEnvVars`
 * are deliberately not in it (they gate whether the plugin may run, they are not
 * this transport's credential), so a transport that declares an identity without
 * declaring a required variable of its own hands its module an EMPTY environment
 * and every provider call it makes is unauthenticated. The symptom is a relay
 * that reports every domain unverified forever, with the only evidence a provider
 * 401 in a scheduled action's log — so it is refused where the author can read
 * why.
 */
function validateDomainIdentity(
	transport: Record<string, unknown>,
	path: string,
	declaredEnvVars: DeclaredConfigEnvVars,
	issues: PluginManifestIssue[]
): void {
	const identity = readDataProperty(transport, 'domainIdentity', issues, false, path);
	if (identity.kind !== 'value') return;
	const identityPath = `${path}.domainIdentity`;
	if (!isRecord(identity.value)) {
		addManifestIssue(issues, 'invalid_type', identityPath, 'must be a plain object');
		return;
	}
	validateKnownFields(identity.value, identityPath, new Set(['module']), issues);
	validateModule(identity.value, identityPath, issues);
	if (declaredEnvVars.requiredEnvVars.size === 0) {
		addManifestIssue(
			issues,
			'invalid_format',
			identityPath,
			'must accompany at least one requiredEnvVars entry — the identity module is handed ' +
				"this transport's own configuration, and with none it calls the provider unauthenticated"
		);
	}
}

/** The declared capability fields — each optional, each with a fail-closed default. */
function validateCapabilities(
	transport: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	validateEnumField(
		transport,
		path,
		'supportsCustomReturnPath',
		['no'],
		issues,
		// The one field whose accepted set is a single value: naming it alone would
		// read as a typo rather than as a tier boundary, so the message says which
		// wire is missing. See PluginSendTransportCustomReturnPathSupport.
		" — 'yes' and 'probe' need an envelope sender the host signs, which a " +
			'bundled transport is never handed'
	);
	validateEnumField(transport, path, 'messageIdSource', ['provider', 'composed'], issues);
	const dedup = readDataProperty(transport, 'deduplicatesOnIdempotencyKey', issues, false, path);
	if (dedup.kind === 'value' && typeof dedup.value !== 'boolean') {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.deduplicatesOnIdempotencyKey`,
			'must be a boolean'
		);
	}
}

/**
 * A closed-set field.
 *
 * The message NAMES the accepted values rather than describing them, because the
 * words this tier refuses (`yes` and `probe` on the return path,
 * `idempotency-key` as the id source) are words the CORE catalog accepts — an
 * author reading the core vocabulary and writing one of them needs to be told
 * which set they are in, not that their string was malformed. `note` carries the
 * reason for the field whose accepted set is too small to explain itself.
 */
function validateEnumField(
	transport: Record<string, unknown>,
	path: string,
	field: string,
	accepted: readonly string[],
	issues: PluginManifestIssue[],
	note = ''
): void {
	const property = readDataProperty(transport, field, issues, false, path);
	if (property.kind !== 'value') return;
	if (typeof property.value !== 'string' || !accepted.includes(property.value)) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.${field}`,
			`must be one of ${accepted.join(', ')}${note}`
		);
	}
}

function validateRetryDelays(
	transport: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const retryDelays = readDataProperty(transport, 'retryDelays', issues, true, path);
	if (retryDelays.kind !== 'value') return;
	const items = validateDescriptorSafeArray(retryDelays.value, `${path}.retryDelays`, issues);
	if (!items) return;
	if (items.length > MAX_RETRIES) {
		addManifestIssue(
			issues,
			'too_many_items',
			`${path}.retryDelays`,
			`must contain at most ${MAX_RETRIES} delays`
		);
		return;
	}
	let total = 0;
	for (const [index, item] of items.entries()) {
		if (
			item.kind !== 'value' ||
			!Number.isSafeInteger(item.value) ||
			(item.value as number) < 0 ||
			(item.value as number) > MAX_RETRY_DELAY_MS
		) {
			if (item.kind === 'value') {
				addManifestIssue(
					issues,
					'invalid_type',
					`${path}.retryDelays[${index}]`,
					`must be an integer from 0 to ${MAX_RETRY_DELAY_MS}`
				);
			}
			continue;
		}
		total += item.value as number;
	}
	if (total > MAX_TOTAL_DELAY_MS) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.retryDelays`,
			`must total at most ${MAX_TOTAL_DELAY_MS} milliseconds`
		);
	}
}
