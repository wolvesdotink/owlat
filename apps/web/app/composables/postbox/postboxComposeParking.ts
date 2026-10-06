/**
 * The compose request's parked-text rules, as pure functions over the request
 * record (`usePostboxComposeNav`): folding rowless snapshots into a seed,
 * parking a leave, turning an open's text into a recovery source. The page's
 * wiring is `usePostboxComposePageRequest`, which re-exports these; split out
 * for the file-size ratchet.
 */

import {
	MIRROR_FIELD_NAMES,
	canonicalBlocks,
	isBlankMirrorFields,
	mirrorFieldEqual,
	mirrorFieldsOfRow,
	type MirrorFieldName,
	type MirrorFields,
} from '~/utils/postboxDraftMirror';
import {
	composeRandomId,
	seedCarriesText,
	withoutCreationKeys,
	withoutSeedText,
	type ComposeRequest,
	type ComposeSpec,
	type RecoverySource,
} from './usePostboxComposeNav';
import type { ParkableSnapshot } from './usePostboxComposeRow';

/** The prefill key each mirrored field travels under in a seed. */
const PREFILL_KEY = {
	toAddresses: 'prefillTo',
	ccAddresses: 'prefillCc',
	bccAddresses: 'prefillBcc',
	subject: 'prefillSubject',
	bodyHtml: 'prefillBodyHtml',
	bodyBlocks: 'prefillBodyBlocks',
	composerMode: 'prefillComposerMode',
	followUpRemindAt: 'prefillFollowUpRemindAt',
} as const satisfies Record<MirrorFieldName, keyof ComposeSpec>;

/** `seed` with a parked snapshot's present fields laid over it. */
export function seedWithParked(seed: ComposeSpec, source: RecoverySource): ComposeSpec {
	const next: Record<string, unknown> = { ...seed };
	for (const name of source.present) {
		if (name === 'bodyBlocks') {
			if (source.fields.bodyBlocks === null) continue;
			try {
				next[PREFILL_KEY.bodyBlocks] = JSON.parse(source.fields.bodyBlocks) as unknown[];
			} catch {
				// Malformed blocks: the body HTML still carries the text.
			}
			continue;
		}
		const value = source.fields[name];
		next[PREFILL_KEY[name]] = Array.isArray(value) ? [...value] : value;
	}
	return next as unknown as ComposeSpec;
}

/**
 * The composer's seed with the request's rowless snapshots laid over it,
 * oldest first (the newest wins), and those snapshots. Only for a request with
 * no row yet: the record keeps them as recovery sources until something else
 * holds the text, so a nonce that turns out to name an existing row (whose
 * text may be newer) offers them instead of having them imposed.
 */
export function foldRowless(
	seed: ComposeSpec,
	request: ComposeRequest
): { seed: ComposeSpec; folded: RecoverySource[] } {
	const parked = [...request.sources, ...(request.current ? [request.current] : [])];
	const folded = parked.filter((source) => source.rowless).sort((a, b) => a.parkedAt - b.parkedAt);
	let next = seed;
	for (const source of folded) next = seedWithParked(next, source);
	return { seed: next, folded };
}

/** The seed the composer opens with. */
export function composerSeedOf(request: ComposeRequest): ComposeSpec {
	// A request with a row must not run creation-time work again on a remount.
	const base = request.draftId ? withoutCreationKeys(request.seed) : request.seed;
	return {
		...base,
		mailboxId: request.mailboxId,
		requestNonce: request.requestNonce,
		...(request.draftId ? { draftId: request.draftId } : {}),
	};
}

/** Every present field of `source` equals the row. */
export function equalsRow(
	source: Pick<RecoverySource, 'fields' | 'present'>,
	row: MirrorFields
): boolean {
	return source.present.every((name) => mirrorFieldEqual(name, source.fields, row));
}

/** The record after a leave with `snap` on screen. */
export function parkLeave(
	request: ComposeRequest,
	snap: ParkableSnapshot,
	mountId: string,
	now: number
): ComposeRequest {
	const sources = [...request.sources];
	// An earlier mount's unresolved snapshot is kept on its own; this mount's
	// own earlier park (a `pagehide` before a bfcache return) is replaced.
	if (request.current && request.current.mountId !== mountId) sources.push(request.current);
	const saved = snap.base !== null && equalsRow(snap, snap.base);
	const empty =
		snap.present.length === 0 ||
		(snap.draftId === null && isBlankMirrorFields(snap.fields) && !seedCarriesText(request.seed));
	const current: RecoverySource | undefined =
		saved || empty
			? undefined
			: {
					id: composeRandomId(),
					fields: snap.fields,
					present: snap.present,
					base: snap.base,
					rowless: snap.draftId === null,
					mountId,
					parkedAt: now,
				};
	// The open's text is in the parked snapshot (seeded fields count as
	// present even before the row loads), or saved: from here on it is
	// judged like any parked text, never imposed on the row again.
	const seed = current || saved ? withoutSeedText(request.seed) : request.seed;
	const draftId = request.draftId ?? snap.draftId ?? undefined;
	return { ...request, seed, ...(draftId ? { draftId } : {}), current, sources };
}

/**
 * The open's text as a recovery source: a later mount does not impose it on
 * the row (the first open did; a crash may have kept it from being parked).
 */
export function sourceFromSeed(request: ComposeRequest): RecoverySource | null {
	const seed = request.seed;
	if (!seed || !seedCarriesText(seed)) return null;
	const fields: MirrorFields = mirrorFieldsOfRow({});
	const present: MirrorFieldName[] = [];
	for (const name of MIRROR_FIELD_NAMES) {
		const value = seed[PREFILL_KEY[name]];
		if (value === undefined) continue;
		present.push(name);
		const target = fields as unknown as Record<string, unknown>;
		if (name === 'bodyBlocks') target[name] = canonicalBlocks(value as unknown[]);
		else target[name] = Array.isArray(value) ? [...value] : value;
	}
	return {
		id: composeRandomId(),
		fields,
		present,
		base: null,
		rowless: !request.draftId,
		mountId: 'open',
		parkedAt: request.createdAt,
	};
}

/** The record without the named sources. */
export function withoutSources(request: ComposeRequest, ids: readonly string[]): ComposeRequest {
	if (ids.length === 0) return request;
	return {
		...request,
		current: request.current && ids.includes(request.current.id) ? undefined : request.current,
		sources: request.sources.filter((source) => !ids.includes(source.id)),
	};
}
