'use node';

/**
 * The pre-send checks' one server round trip: link and image probes plus the
 * MTA's content-screening verdict for a rendered email. See `presendChecks.ts`
 * for the floor and the bounds, `presendProbes.ts` for how URLs are probed.
 */

import { v } from 'convex/values';
import {
	CONTENT_SCREENING_MAX_HTML_BYTES,
	CONTENT_SCREENING_MAX_SUBJECT_CHARS,
	normalizeContentScreeningVerdict,
	type MtaContentScreeningRequest,
	type MtaContentScreeningVerdict,
} from '@owlat/mta-protocol/contentScreening';
import { internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { rateLimiter } from '../lib/rateLimiter';
import { throwInvalidInput, throwRateLimited } from '../_utils/errors';
import { getMtaConfig, mtaFetch } from '../mail/mtaClient';
import { PRESEND_MAX_IMAGES, PRESEND_MAX_LINKS, PRESEND_MAX_URL_CHARS } from './presendChecks';
import { probeResources, type ImageProbe, type LinkProbe } from './presendProbes';

/** The MTA answers from Redis plus, at most, one 5 s rspamd call. */
const SCREENING_TIMEOUT_MS = 10_000;

export type ScreeningView =
	| { status: 'ready'; verdict: MtaContentScreeningVerdict }
	/** No MTA on this instance, an MTA that predates `/scan/content`, or a fault. */
	| { status: 'unavailable' }
	/** The caller did not ask for screening. */
	| { status: 'not_requested' };

export interface PresendRunResult {
	links: LinkProbe[];
	images: ImageProbe[];
	screening: ScreeningView;
}

function boundedUrls(urls: string[], max: number, label: string): string[] {
	const unique = [...new Set(urls)];
	if (unique.length > max) throwInvalidInput(`At most ${max} ${label} can be checked at once.`);
	for (const url of unique) {
		if (url.length > PRESEND_MAX_URL_CHARS) throwInvalidInput(`A ${label} URL is too long.`);
		if (!/^https?:\/\//i.test(url)) throwInvalidInput(`Only http and https ${label} are checked.`);
	}
	return unique;
}

async function screen(request: MtaContentScreeningRequest): Promise<ScreeningView> {
	const mta = getMtaConfig();
	if (!mta) return { status: 'unavailable' };
	try {
		const response = await mtaFetch(
			mta,
			'/scan/content',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request),
			},
			SCREENING_TIMEOUT_MS
		);
		if (!response.ok) return { status: 'unavailable' };
		const verdict = normalizeContentScreeningVerdict(await response.json().catch(() => null));
		return verdict ? { status: 'ready', verdict } : { status: 'unavailable' };
	} catch {
		return { status: 'unavailable' };
	}
}

// authz: campaigns:manage via internal.emailTemplates.presendChecks.authorize —
// the probes make outbound requests on the caller's behalf.
export const run = authedAction({
	args: {
		links: v.array(v.string()),
		images: v.array(v.string()),
		screening: v.optional(
			v.object({
				subject: v.string(),
				html: v.string(),
				fromEmail: v.optional(v.string()),
			})
		),
	},
	handler: async (ctx, args): Promise<PresendRunResult> => {
		const { userId, defaultFromEmail } = await ctx.runQuery(
			internal.emailTemplates.presendChecks.authorize,
			{}
		);

		const links = boundedUrls(args.links, PRESEND_MAX_LINKS, 'links');
		const images = boundedUrls(args.images, PRESEND_MAX_IMAGES, 'images');
		const screening = args.screening;
		if (screening) {
			if (Buffer.byteLength(screening.html) > CONTENT_SCREENING_MAX_HTML_BYTES) {
				throwInvalidInput('The email is too large to screen.');
			}
			if (screening.subject.length > CONTENT_SCREENING_MAX_SUBJECT_CHARS) {
				throwInvalidInput('The subject is too long.');
			}
		}

		const limit = await rateLimiter.limit(ctx, 'presendChecks', { key: userId });
		if (!limit.ok) {
			throwRateLimited('Too many checks in a row. Try again in a moment.', limit.retryAfter);
		}

		const from = screening?.fromEmail?.trim() || defaultFromEmail || undefined;
		const [probes, screeningView] = await Promise.all([
			probeResources(links, images),
			screening
				? screen({
						// A header value: no line breaks, whatever the caller typed.
						subject: screening.subject.replace(/[\r\n]+/g, ' '),
						html: screening.html,
						...(from && !/[\r\n]/.test(from) ? { from } : {}),
					})
				: Promise.resolve<ScreeningView>({ status: 'not_requested' }),
		]);
		return { ...probes, screening: screeningView };
	},
});
