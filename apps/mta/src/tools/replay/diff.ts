/**
 * Divergence classification for the inbound shadow-replay harness (piece C0).
 *
 * Field-level diff of two driver projections plus the message-level auth
 * verdicts, marking the exact, enumerated set of sanctioned inbound behaviour
 * changes (I2). Any divergence NOT carrying a sanction is an unsanctioned defect
 * that fails the replay gate.
 */

import type { DkimVerdict } from '@owlat/mail-auth';
import type { RoutingDrivers } from './drivers.js';

/** Context that JUSTIFIES a sanctioned DKIM divergence (I2 (a)/(d)). */
export interface DkimContext {
	/** The message carried an `l=` body-length tag (drives the neutral cap). */
	readonly hadLTag?: boolean;
	/** The signature algorithm (`rsa-sha1` drives the policy-fail divergence). */
	readonly algorithm?: string;
}

/**
 * The message-level auth verdicts a stack produces for a message + envelope.
 * Every verdict is drawn from the RFC 8601 {@link DkimVerdict} vocabulary the
 * production drivers already record.
 */
export interface AuthVerdicts {
	readonly dkim?: DkimVerdict;
	readonly spf?: DkimVerdict;
	readonly dmarc?: DkimVerdict;
	/** Only meaningful on the NEW stack — annotates why a DKIM divergence is sanctioned. */
	readonly dkimContext?: DkimContext;
}

export type DivergenceCategory = 'parse-field' | 'dkim-verdict' | 'spf-verdict' | 'dmarc-verdict';

/**
 * The exact, enumerated set of sanctioned inbound behaviour changes (I2) this
 * harness can classify: (a) `l=` -> neutral cap, (d) rsa-sha1 policy fail, and
 * (b) corrected per-part charset decoding. Enhanced-status-code corrections are
 * an SMTP-reply improvement produced elsewhere, not a parse field or DKIM
 * verdict, so they are not a kind this harness emits.
 */
export type SanctionKind = 'dkim-l-neutral' | 'rsa-sha1-policy' | 'charset';

/** One field-level divergence between the old and new stacks for one message. */
export interface Divergence {
	readonly field: string;
	readonly category: DivergenceCategory;
	readonly oldValue: string;
	readonly newValue: string;
	readonly sanctioned: boolean;
	readonly sanction?: SanctionKind;
}

/** Field paths whose divergence is pre-signed as a sanctioned improvement (I2). */
export type SanctionedFields = Readonly<Record<string, SanctionKind>>;

/** Stable JSON of a driver field for a divergence record (never raw body text). */
function fieldValue(value: unknown): string {
	return JSON.stringify(value);
}

/** Diff two driver projections field by field; mark pre-signed sanctions. */
export function diffDrivers(
	oldD: RoutingDrivers,
	newD: RoutingDrivers,
	sanctioned: SanctionedFields = {}
): Divergence[] {
	const out: Divergence[] = [];
	const fields: readonly (keyof RoutingDrivers)[] = [
		'subject',
		'messageId',
		'inReplyTo',
		'references',
		'date',
		'from',
		'to',
		'cc',
		'bcc',
		'replyTo',
		'text',
		'html',
		'attachments',
		'contentType',
	];
	for (const field of fields) {
		const oldValue = fieldValue(oldD[field]);
		const newValue = fieldValue(newD[field]);
		if (oldValue === newValue) continue;
		const kind = sanctioned[field];
		out.push({
			field,
			category: 'parse-field',
			oldValue,
			newValue,
			sanctioned: kind !== undefined,
			...(kind !== undefined ? { sanction: kind } : {}),
		});
	}
	return out;
}

/**
 * Classify a DKIM verdict divergence. The ONLY sanctioned DKIM divergences
 * (I2) are: (a) `l=` present, old `pass` -> new `neutral` (append-attack cap),
 * and (d) `rsa-sha1`, old `pass` -> new `fail` (RFC 8301 policy). Everything
 * else is an unsanctioned defect.
 */
function classifyDkim(
	oldV: DkimVerdict,
	newV: DkimVerdict,
	ctx: DkimContext | undefined
): SanctionKind | undefined {
	if (oldV === 'pass' && newV === 'neutral' && ctx?.hadLTag === true) return 'dkim-l-neutral';
	if (oldV === 'pass' && newV === 'fail' && ctx?.algorithm === 'rsa-sha1') return 'rsa-sha1-policy';
	return undefined;
}

/** Diff two auth-verdict sets. SPF/DMARC divergences are never sanctioned here. */
export function diffAuth(oldA: AuthVerdicts, newA: AuthVerdicts): Divergence[] {
	const out: Divergence[] = [];

	if (oldA.dkim !== undefined && newA.dkim !== undefined && oldA.dkim !== newA.dkim) {
		const kind = classifyDkim(oldA.dkim, newA.dkim, newA.dkimContext);
		out.push({
			field: 'dkim',
			category: 'dkim-verdict',
			oldValue: oldA.dkim,
			newValue: newA.dkim,
			sanctioned: kind !== undefined,
			...(kind !== undefined ? { sanction: kind } : {}),
		});
	}

	const scalar: readonly { key: 'spf' | 'dmarc'; category: DivergenceCategory }[] = [
		{ key: 'spf', category: 'spf-verdict' },
		{ key: 'dmarc', category: 'dmarc-verdict' },
	];
	for (const { key, category } of scalar) {
		const oldV = oldA[key];
		const newV = newA[key];
		if (oldV !== undefined && newV !== undefined && oldV !== newV) {
			out.push({ field: key, category, oldValue: oldV, newValue: newV, sanctioned: false });
		}
	}
	return out;
}
