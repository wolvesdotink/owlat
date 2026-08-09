import {
	isBoundedReplayToleranceSeconds,
	isPluginSecretEnvVar,
	PLUGIN_INBOUND_MAX_NAME_LENGTH,
	PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS,
} from './inboundSignature';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import { isRecord, readDataProperty, validateKnownFields } from './manifestValue';

/**
 * The one validator for an inbound signature-verification contract, shared by
 * every contribution that declares one (import providers, send-transport
 * feedback webhooks).
 *
 * Replay defense is the difference between the callers, and it is a MODE rather
 * than an option so neither caller can drift into the other's rule: a contract
 * that gates a live HTTP endpoint must carry replay defense, and a contract that
 * gates none must not pretend to (an accepted-but-unused replay field would read
 * as protection nothing enforces).
 *
 * The mode also decides whether there is a SCHEME to choose. An endpoint-gating
 * contract picks one of the host-verified words in {@link ENDPOINT_SCHEMES} —
 * the parameterized HMAC (the default, and what a contract spelling no scheme
 * means) or `svix`, whose replay defense is intrinsic and whose only declared
 * facts are the secret variable and the tolerance. The origin-only form has one
 * shape and no vocabulary, so `scheme` is simply an unknown field there.
 */
export type InboundSignatureReplayMode = 'required' | 'forbidden';

const HEADER = /^[a-z0-9][a-z0-9-]*$/;
const BASE_FIELDS = ['header', 'algorithm', 'encoding', 'secretEnvVar'] as const;
const REPLAY_FIELDS = new Set(['timestampHeader', 'toleranceSeconds']);
const SVIX_FIELDS = new Set(['scheme', 'secretEnvVar', 'toleranceSeconds']);
const ALGORITHMS = new Set(['hmac-sha256', 'hmac-sha1']);
const ENCODINGS = new Set(['hex', 'base64']);
const MAX_HEADER_LENGTH = PLUGIN_INBOUND_MAX_NAME_LENGTH;

/**
 * The words an ENDPOINT-GATING contract may name, and the only place they are
 * listed for validation. Both are host-verified schemes; `aws-sns` and
 * `mandrill-form` are absent on purpose (host infrastructure and a legacy vendor
 * shape respectively — see `PluginSvixSignatureContract` in
 * `./inboundSignature`).
 */
const ENDPOINT_SCHEMES = new Set(['hmac-timestamp-body', 'svix']);

/**
 * Validate the signature contract at `path`, which the caller has already read
 * out of its contribution and proven present.
 *
 * Returns the well-formed `secretEnvVar`, or `undefined` when the contract does
 * not name one this validator would accept. Returned rather than re-read by the
 * caller because every property here is read exactly once: a second
 * `readDataProperty` on the same field would report a getter twice and, for a
 * hostile manifest, is precisely the time-of-check/time-of-use gap the snapshot
 * pass exists to close.
 */
export function validateInboundSignatureContract(
	value: unknown,
	path: string,
	replayMode: InboundSignatureReplayMode,
	issues: PluginManifestIssue[]
): string | undefined {
	if (!isRecord(value)) {
		addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
		return undefined;
	}

	// THE DISCRIMINANT, READ FIRST, and only where there is a choice to make. An
	// endpoint-gating contract picks a word from the host's vocabulary; the
	// origin-only form has exactly one shape, so `scheme` is not a known field
	// there and `validateKnownFields` below reports it as such — a `svix` contract
	// cannot be smuggled onto a surface whose verifier does not enforce freshness.
	//
	// A WORD THIS HOST CANNOT VERIFY WITH STOPS VALIDATION, rather than falling
	// through to the default shape's rules. Those rules would report a pile of
	// missing HMAC fields about a contract whose real fault is its scheme, and —
	// worse — a `secretEnvVar` accepted on the way past would be reported to the
	// caller as a variable the flag must require, for a webhook that will never
	// compose.
	const scheme =
		replayMode === 'required'
			? readDataProperty(value, 'scheme', issues, false, path)
			: ({ kind: 'missing' } as const);
	if (scheme.kind === 'value') {
		if (typeof scheme.value !== 'string' || !ENDPOINT_SCHEMES.has(scheme.value)) {
			addManifestIssue(
				issues,
				'invalid_format',
				`${path}.scheme`,
				'must be hmac-timestamp-body or svix'
			);
			return undefined;
		}
		if (scheme.value === 'svix') return validateSvixContract(value, path, issues);
	} else if (scheme.kind === 'accessor') {
		// The accessor issue is already recorded and its value was never evaluated,
		// so the shape it would have named is unknown. Nothing further to check.
		return undefined;
	}

	const known = new Set<string>(BASE_FIELDS);
	if (replayMode === 'required') known.add('replay').add('scheme');
	validateKnownFields(value, path, known, issues);

	validateHeaderName(value, 'header', path, issues);

	const algorithm = readDataProperty(value, 'algorithm', issues, true, path);
	if (
		algorithm.kind === 'value' &&
		(typeof algorithm.value !== 'string' || !ALGORITHMS.has(algorithm.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.algorithm`,
			'must be hmac-sha256 or hmac-sha1'
		);
	}

	const encoding = readDataProperty(value, 'encoding', issues, true, path);
	if (
		encoding.kind === 'value' &&
		(typeof encoding.value !== 'string' || !ENCODINGS.has(encoding.value))
	) {
		addManifestIssue(issues, 'invalid_format', `${path}.encoding`, 'must be hex or base64');
	}

	const acceptedSecretEnvVar = validateSecretEnvVar(value, path, issues);
	if (replayMode === 'required') validateReplay(value, path, issues);
	return acceptedSecretEnvVar;
}

/**
 * The Svix arm: two declared facts and nothing else.
 *
 * Everything the parameterized HMAC arm spells — the headers, the family, the
 * encoding, the signed string — belongs to the scheme and is implemented once in
 * the host, so a manifest that named any of it could only disagree with the
 * scheme it chose. `validateKnownFields` therefore refuses those words HERE
 * rather than ignoring them: a contract carrying `header: 'x-my-signature'`
 * beside `scheme: 'svix'` is an author who believes the host will read that
 * header, and silence would ship that belief.
 *
 * The freshness window is bounded by the same predicate, against the same
 * ceiling, as the other arm's `replay.toleranceSeconds` — the tolerance is what
 * bounds how long a captured request stays valid, and the scheme it is enforced
 * under does not change what an unbounded one would cost.
 */
function validateSvixContract(
	value: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): string | undefined {
	validateKnownFields(value, path, SVIX_FIELDS, issues);
	const acceptedSecretEnvVar = validateSecretEnvVar(value, path, issues);
	const tolerance = readDataProperty(value, 'toleranceSeconds', issues, true, path);
	if (tolerance.kind === 'value' && !isBoundedReplayToleranceSeconds(tolerance.value)) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.toleranceSeconds`,
			`must be an integer from 1 to ${PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS}`
		);
	}
	return acceptedSecretEnvVar;
}

/**
 * The signing variable, for every arm and every mode.
 *
 * The namespace rule itself lives in `./inboundSignature`, beside the contract
 * type, because the HOST re-asserts it when it loads a generated artifact — and
 * two spellings of a security floor are one spelling too many. The same is true
 * one level down: the rule reaches both arms through this one reader, so a new
 * scheme cannot arrive with a weaker fence by forgetting to call it.
 */
function validateSecretEnvVar(
	value: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): string | undefined {
	const secretEnvVar = readDataProperty(value, 'secretEnvVar', issues, true, path);
	if (secretEnvVar.kind !== 'value') return undefined;
	if (isPluginSecretEnvVar(secretEnvVar.value)) return secretEnvVar.value;
	addManifestIssue(
		issues,
		'invalid_format',
		`${path}.secretEnvVar`,
		'must be a PLUGIN_-prefixed uppercase environment variable name'
	);
	return undefined;
}

function validateReplay(
	signature: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const replay = readDataProperty(signature, 'replay', issues, true, path);
	if (replay.kind !== 'value') return;
	const replayPath = `${path}.replay`;
	if (!isRecord(replay.value)) {
		addManifestIssue(issues, 'invalid_type', replayPath, 'must be a plain object');
		return;
	}
	validateKnownFields(replay.value, replayPath, REPLAY_FIELDS, issues);
	validateHeaderName(replay.value, 'timestampHeader', replayPath, issues);

	const tolerance = readDataProperty(replay.value, 'toleranceSeconds', issues, true, replayPath);
	if (tolerance.kind === 'value' && !isBoundedReplayToleranceSeconds(tolerance.value)) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${replayPath}.toleranceSeconds`,
			`must be an integer from 1 to ${PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS}`
		);
	}
}

function validateHeaderName(
	record: Record<string, unknown>,
	field: string,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const header = readDataProperty(record, field, issues, true, path);
	if (
		header.kind === 'value' &&
		(typeof header.value !== 'string' ||
			header.value.length > MAX_HEADER_LENGTH ||
			!HEADER.test(header.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.${field}`,
			'must be a lower-case HTTP header name'
		);
	}
}
