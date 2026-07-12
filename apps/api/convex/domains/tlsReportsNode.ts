'use node';

/**
 * TLS-RPT (RFC 8460) decode + ingest, in the Node runtime.
 *
 * The shared parser's gunzip step uses the WHATWG `DecompressionStream`, which
 * is a Node/browser global but is NOT part of Convex's default (V8 isolate)
 * runtime API surface — calling it from an `httpAction` would throw
 * `DecompressionStream is not defined` in production. So the webhook handler
 * (`domains/tlsReportsHttp.ts`) verifies the signature in the isolate, then
 * hands the base64 attachment to THIS `'use node'` action, which decodes,
 * validates with the shared never-throwing parser, digests, and calls the
 * idempotent `domains/tlsReports.ts:ingest` mutation.
 *
 * Internal-only: reachable solely from the authenticated webhook handler.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { decodeTlsReport, parseTlsReport, digestTlsReport } from '@owlat/shared';

/**
 * Decode one forwarded TLS-RPT attachment and (if valid) ingest its digest.
 * Never throws: a bad base64, corrupt gzip, or malformed report all resolve to
 * `{ ok: false, reason }` so the caller can acknowledge without retrying.
 */
export const decodeAndIngest = internalAction({
	args: { contentBase64: v.string(), isPlainJson: v.boolean() },
	returns: v.object({
		ok: v.boolean(),
		reason: v.optional(v.string()),
		deduped: v.optional(v.boolean()),
	}),
	handler: async (ctx, args) => {
		let bytes: Uint8Array;
		try {
			bytes = Uint8Array.from(atob(args.contentBase64), (c) => c.charCodeAt(0));
		} catch {
			return { ok: false, reason: 'bad-base64' };
		}

		// Gzip attachments go through gunzip+parse; a plain `.json` is parsed directly.
		const parsed = args.isPlainJson
			? parseTlsReport(new TextDecoder('utf-8').decode(bytes))
			: await decodeTlsReport(bytes);
		if (!parsed.ok) return { ok: false, reason: parsed.error };

		// The digest's shape is exactly the ingest args — pass it straight through.
		const digest = digestTlsReport(parsed.report);
		const result = await ctx.runMutation(internal.domains.tlsReports.ingest, digest);
		return { ok: true, deduped: result.deduped };
	},
});
