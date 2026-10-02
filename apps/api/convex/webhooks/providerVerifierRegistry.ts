/** Host-owned verification mechanisms for provider feedback contributions. */
import type { ProviderFeedbackVerifier } from '@owlat/provider-kit';
import {
	isPluginSecretEnvVar,
	PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS,
} from '@owlat/plugin-kit';
import { getOptional, getPluginSecret, type EnvKey } from '../lib/env';
import { verifyMandrillSignature, mandrillSignedUrlCandidates } from './adapters/mandrill';
import { verifySvixHeaders } from './adapters/resend';
import {
	clampToleranceSeconds,
	constantTimeEqual,
	hmacSignature,
	isUnixSecondsTimestamp,
	isWithinTimestampTolerance,
	missingSecretResult,
} from './security';

type ProviderVerificationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly status: number; readonly reason: string };

type LegacyVerifier = (request: Request, rawBody: string) => Promise<ProviderVerificationResult>;

function verifierSecret(name: string): string | undefined {
	return isPluginSecretEnvVar(name) ? getPluginSecret(name) : getOptional(name as EnvKey);
}

function invalidSignature(reason = 'Invalid signature'): ProviderVerificationResult {
	return { ok: false, status: 401, reason };
}

/**
 * Every tolerance this registry enforces is DECLARED — by a bundle or, through
 * `providers/feedback.ts:pluginVerifier`, by a plugin manifest's replay contract.
 * It is therefore clamped to the same ceiling the plugin inbound path clamps to,
 * for the same reason: a verifier must not depend on the artifact it is reading
 * having been validated by the version of the kit that is running now.
 */
function declaredTolerance(toleranceSeconds: number): number {
	return clampToleranceSeconds(toleranceSeconds, PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS);
}

const SVIX_HEADERS = ['svix-id', 'svix-timestamp', 'svix-signature'] as const;
const MANDRILL_SIGNATURE_HEADER = 'x-mandrill-signature';

/**
 * The refusal reason for a request missing a header its declared scheme cannot
 * verify without, or `null` when every such header is present (and always for
 * SNS, whose signature travels in the body). The verifiers below answer the
 * same reason, and the pipeline asks this first so it can refuse before
 * reading the body or charging a bucket.
 */
export function missingDeclaredSignatureHeaders(
	request: Request,
	verifier: ProviderFeedbackVerifier
): string | null {
	const has = (name: string) => Boolean(request.headers.get(name));
	switch (verifier.scheme) {
		case 'hmac-timestamp-body':
			return has(verifier.signatureHeader) && has(verifier.timestampHeader)
				? null
				: 'Missing signature headers';
		case 'svix':
			return SVIX_HEADERS.every(has) ? null : 'Missing Svix headers';
		case 'mandrill-form':
			return has(MANDRILL_SIGNATURE_HEADER) ? null : 'Missing X-Mandrill-Signature';
		case 'aws-sns':
			return null;
	}
}

async function verifyTimestampHmac(
	request: Request,
	rawBody: string,
	verifier: Extract<ProviderFeedbackVerifier, { scheme: 'hmac-timestamp-body' }>
): Promise<ProviderVerificationResult> {
	const secret = verifierSecret(verifier.secretEnvVar);
	if (!secret) return missingSecretResult(verifier.secretEnvVar);
	const missing = missingDeclaredSignatureHeaders(request, verifier);
	if (missing) return invalidSignature(missing);
	const signature = request.headers.get(verifier.signatureHeader)!;
	const timestamp = request.headers.get(verifier.timestampHeader)!;
	if (
		!isUnixSecondsTimestamp(timestamp) ||
		!isWithinTimestampTolerance(timestamp, declaredTolerance(verifier.toleranceSeconds), Date.now())
	) {
		return invalidSignature('Invalid or expired signature timestamp');
	}
	const expected = await hmacSignature(
		secret,
		`${timestamp}.${rawBody}`,
		verifier.algorithm,
		verifier.encoding
	);
	return constantTimeEqual(signature, expected) ? { ok: true } : invalidSignature();
}

async function verifySvix(
	request: Request,
	rawBody: string,
	verifier: Extract<ProviderFeedbackVerifier, { scheme: 'svix' }>
): Promise<ProviderVerificationResult> {
	const secret = verifierSecret(verifier.secretEnvVar);
	if (!secret) return missingSecretResult(verifier.secretEnvVar);
	const missing = missingDeclaredSignatureHeaders(request, verifier);
	if (missing) return invalidSignature(missing);
	const header = (name: (typeof SVIX_HEADERS)[number]) => request.headers.get(name)!;
	return (await verifySvixHeaders(
		rawBody,
		header('svix-id'),
		header('svix-timestamp'),
		header('svix-signature'),
		secret,
		Math.floor(Date.now() / 1000),
		declaredTolerance(verifier.toleranceSeconds)
	))
		? { ok: true }
		: invalidSignature();
}

async function verifyMandrillForm(
	request: Request,
	rawBody: string,
	verifier: Extract<ProviderFeedbackVerifier, { scheme: 'mandrill-form' }>
): Promise<ProviderVerificationResult> {
	const secret = verifierSecret(verifier.secretEnvVar);
	if (!secret) return missingSecretResult(verifier.secretEnvVar);
	const missing = missingDeclaredSignatureHeaders(request, verifier);
	if (missing) return invalidSignature(missing);
	const signature = request.headers.get(MANDRILL_SIGNATURE_HEADER)!;
	return (await verifyMandrillSignature(
		mandrillSignedUrlCandidates(request.url),
		rawBody,
		signature,
		secret
	))
		? { ok: true }
		: invalidSignature();
}

/**
 * Verify bytes before a provider parser runs. The AWS SNS implementation keeps
 * its certificate cache and subscription constraints in the host's established
 * verifier while the other accepted schemes are fully parameterized here.
 */
export async function verifyProviderFeedbackRequest(
	request: Request,
	rawBody: string,
	verifier: ProviderFeedbackVerifier,
	legacyVerifier?: LegacyVerifier
): Promise<ProviderVerificationResult> {
	switch (verifier.scheme) {
		case 'hmac-timestamp-body':
			return verifyTimestampHmac(request, rawBody, verifier);
		case 'svix':
			return verifySvix(request, rawBody, verifier);
		case 'mandrill-form':
			return verifyMandrillForm(request, rawBody, verifier);
		case 'aws-sns':
			if (!legacyVerifier) {
				return { ok: false, status: 503, reason: 'SNS verifier is unavailable' };
			}
			return legacyVerifier(request, rawBody);
	}
}
