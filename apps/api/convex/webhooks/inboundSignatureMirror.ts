/**
 * F1 (D9): the clearsigned-body signature mirror for the AI-inbox ingest path.
 *
 * The `inbound.received` dispatcher carries parsed bodies (no raw MIME), so
 * only a CLEARSIGNED body — whose signature travels inline in the text — can
 * be verified there. This helper runs the shared `'use node'` verifier and
 * shapes its honest verdict into the two display fields `inboundMessages`
 * mirrors (`isInboundSignatureValid` / `inboundSignerFingerprint`); the full
 * `inboundSignatureInfo` record lives on the personal-mailbox side.
 *
 * Best-effort by contract: a verifier failure returns `undefined` (the fields
 * stay ABSENT, which renders "not verified"), and delivery into the inbox is
 * never blocked. Isolate-safe — no Node `Buffer`, Web APIs only.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { isClearsigned } from '@owlat/shared/secureMessage';
import { logError } from '../lib/runtimeLog';

/** The two mirrored display fields `inbox.messages.receiveMessage` accepts. */
export interface SignatureMirrorFields {
	isInboundSignatureValid: boolean;
	inboundSignerFingerprint?: string;
}

/**
 * Verify a clearsigned inbound body and return the mirror fields, or
 * `undefined` when the body is not clearsigned (the common case, checked
 * cheaply before any action spawns) or the verifier failed.
 */
export async function clearsignedSignatureMirror(
	ctx: ActionCtx,
	textBody: string | undefined,
	from: string
): Promise<SignatureMirrorFields | undefined> {
	if (!textBody || !isClearsigned(textBody)) return undefined;
	try {
		const verdict = await ctx.runAction(internal.e2ee.verifyInboundSignature.forInbound, {
			rawBytesBase64: utf8ToBase64(textBody),
			from,
		});
		if (!verdict.isSigned) return undefined;
		return {
			isInboundSignatureValid: verdict.info.isSignatureValid,
			...(verdict.info.signerFingerprint
				? { inboundSignerFingerprint: verdict.info.signerFingerprint }
				: {}),
		};
	} catch (err) {
		logError('[Webhook Dispatcher] inbound signature verification failed', err);
		return undefined;
	}
}

/**
 * UTF-8 → base64 with Web APIs only — this module runs in the default Convex
 * isolate (no Node `Buffer`). Chunked so a large body never hits the
 * `String.fromCharCode(...spread)` argument limit.
 */
function utf8ToBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	const CHUNK = 8192;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
