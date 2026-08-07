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
 * `replay` is the only difference between the callers, and it is a MODE rather
 * than an option so neither caller can drift into the other's rule: a contract
 * that gates a live HTTP endpoint must carry replay provisions, and a contract
 * that gates none must not pretend to (an accepted-but-unused replay field would
 * read as protection nothing enforces).
 */
export type InboundSignatureReplayMode = 'required' | 'forbidden';

const HEADER = /^[a-z0-9][a-z0-9-]*$/;
const BASE_FIELDS = ['header', 'algorithm', 'encoding', 'secretEnvVar'] as const;
const REPLAY_FIELDS = new Set(['timestampHeader', 'toleranceSeconds']);
const ALGORITHMS = new Set(['hmac-sha256', 'hmac-sha1']);
const ENCODINGS = new Set(['hex', 'base64']);
const MAX_HEADER_LENGTH = PLUGIN_INBOUND_MAX_NAME_LENGTH;

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
	const known = new Set<string>(BASE_FIELDS);
	if (replayMode === 'required') known.add('replay');
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

	// The namespace rule itself lives in `./inboundSignature`, beside the contract
	// type, because the HOST re-asserts it when it loads a generated artifact —
	// and two spellings of a security floor are one spelling too many.
	const secretEnvVar = readDataProperty(value, 'secretEnvVar', issues, true, path);
	let acceptedSecretEnvVar: string | undefined;
	if (secretEnvVar.kind === 'value') {
		if (isPluginSecretEnvVar(secretEnvVar.value)) {
			acceptedSecretEnvVar = secretEnvVar.value;
		} else {
			addManifestIssue(
				issues,
				'invalid_format',
				`${path}.secretEnvVar`,
				'must be a PLUGIN_-prefixed uppercase environment variable name'
			);
		}
	}

	if (replayMode === 'required') validateReplay(value, path, issues);
	return acceptedSecretEnvVar;
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
