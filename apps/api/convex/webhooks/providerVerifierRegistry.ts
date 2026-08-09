/** Host-owned verification mechanisms for provider feedback contributions. */
import type { ProviderFeedbackVerifier } from '@owlat/provider-kit';
import { isPluginSecretEnvVar } from '@owlat/plugin-kit';
import { getOptional, getPluginSecret, type EnvKey } from '../lib/env';
import { verifyMandrillSignature, mandrillSignedUrlCandidates } from './adapters/mandrill';
import { verifySvixHeaders } from './adapters/resend';
import { bytesToBase64, bytesToHex, constantTimeEqual, missingSecretResult } from './security';

export type ProviderVerificationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly status: number; readonly reason: string };

type LegacyVerifier = (request: Request, rawBody: string) => Promise<ProviderVerificationResult>;

function verifierSecret(name: string): string | undefined {
	return isPluginSecretEnvVar(name) ? getPluginSecret(name) : getOptional(name as EnvKey);
}

function invalidSignature(reason = 'Invalid signature'): ProviderVerificationResult {
	return { ok: false, status: 401, reason };
}

async function computeTimestampHmac(
	secret: string,
	signed: string,
	algorithm: 'sha256' | 'sha1',
	encoding: 'hex' | 'base64'
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: algorithm === 'sha256' ? 'SHA-256' : 'SHA-1' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
	return encoding === 'hex' ? bytesToHex(signature) : bytesToBase64(signature);
}

async function verifyTimestampHmac(
	request: Request,
	rawBody: string,
	verifier: Extract<ProviderFeedbackVerifier, { scheme: 'hmac-timestamp-body' }>
): Promise<ProviderVerificationResult> {
	const secret = verifierSecret(verifier.secretEnvVar);
	if (!secret) return missingSecretResult(verifier.secretEnvVar);
	const signature = request.headers.get(verifier.signatureHeader);
	const timestamp = request.headers.get(verifier.timestampHeader);
	if (!signature || !timestamp) return invalidSignature('Missing signature headers');
	const seconds = Number(timestamp);
	if (
		!Number.isSafeInteger(seconds) ||
		Math.abs(Math.floor(Date.now() / 1_000) - seconds) > verifier.toleranceSeconds
	) {
		return invalidSignature('Invalid or expired signature timestamp');
	}
	const signed = `${timestamp}.${rawBody}`;
	const expected = await computeTimestampHmac(
		secret,
		signed,
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
	const id = request.headers.get('svix-id');
	const timestamp = request.headers.get('svix-timestamp');
	const signature = request.headers.get('svix-signature');
	if (!id || !timestamp || !signature) return invalidSignature('Missing Svix headers');
	return (await verifySvixHeaders(rawBody, id, timestamp, signature, secret))
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
	const signature = request.headers.get('x-mandrill-signature');
	if (!signature) return invalidSignature('Missing X-Mandrill-Signature');
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
