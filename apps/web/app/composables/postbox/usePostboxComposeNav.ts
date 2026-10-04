/**
 * Opens the full-page composer (`/dashboard/compose`) for a new message, a
 * reopened draft, a forward as new mail or a resend. It replaced the floating
 * popup stack: one composer with the whole content area, the same editor Answer
 * mode writes replies in.
 *
 * Every open is its own COMPOSE REQUEST, named by `?c=<key>`: the page is keyed
 * on it, so opening a second composition while one is on screen remounts the
 * editor instead of leaving the first one there under the new URL. The request
 * record lives in session state and in this tab's sessionStorage (a reload keeps
 * it) and holds:
 *
 *   - `requestNonce`: passed to `drafts.create`, so every mount of the request
 *     reaches the same row (a remount before the first create resolved does not
 *     make a second draft, and one that was sent or discarded is not recreated);
 *   - `seed`: what the open supplied (prefilled recipients, a quoted body, the
 *     text an offline undo hands back). Its fields win on the first open;
 *   - `draftId`, once the request has a row;
 *   - `current` and `sources`: text parked on a leave that the server may not
 *     hold (see `pages/dashboard/compose.vue`). `current` is the latest leave of
 *     a mount; an earlier mount's unresolved snapshot moves to `sources` rather
 *     than being replaced, so each is resolved on its own;
 *   - `mountId`: the page instance that owns the request. Every write after the
 *     claim names it, so a page that has gone (and whose late callbacks still
 *     run) cannot overwrite what the page that replaced it wrote.
 *
 * Requests expire after 14 days, like the server's nonce binding; an expired or
 * unknown key is never quietly given a fresh nonce (that could create a second
 * row for one composition), the page says so instead.
 */
import type { Id } from '@owlat/api/dataModel';
import type { MirrorFieldName, MirrorFields } from '~/utils/postboxDraftMirror';
import type { ComposerSeed } from './usePostboxCompose';

/** A composer seed plus, on a plain reply, the extras Reply-All would add. */
export type ComposeSpec = ComposerSeed & { replyAllRecipients?: string[] };

/** Text parked on a leave, until it is applied, offered or found saved. */
export interface RecoverySource {
	/** Immutable: names the copy it may become, and the record entry to drop. */
	id: string;
	fields: MirrorFields;
	/** The fields that are real; the rest were never loaded (placeholders). */
	present: MirrorFieldName[];
	/** The row as last observed when parked; null when none had loaded. */
	base: MirrorFields | null;
	/** Parked before the composition had a row: it merges back into the seed. */
	rowless: boolean;
	/** The mount that parked it (its own later leaves replace it). */
	mountId: string;
	parkedAt: number;
}

export interface ComposeRequest {
	v: 1;
	createdAt: number;
	mountId: string | null;
	mailboxId: Id<'mailboxes'>;
	requestNonce: string;
	draftId?: Id<'mailDrafts'>;
	seed?: ComposeSpec;
	current?: RecoverySource;
	sources: RecoverySource[];
}

const COMPOSE_PATH = '/dashboard/compose';
const STORAGE_PREFIX = 'owlat:compose-request:';
/** As long as the server keeps a request nonce bound to its draft. */
export const COMPOSE_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The compose page's instance key: one per compose request (`?c=`), so a new
 * open remounts the editor while the page's own URL rewrite, which keeps `c`,
 * does not. Lives here because `definePageMeta` is hoisted out of the page.
 */
export function composePageKey(rawRequestKey: unknown): string {
	const value = Array.isArray(rawRequestKey) ? rawRequestKey[0] : rawRequestKey;
	return `compose:${typeof value === 'string' ? value : ''}`;
}

/** A colon-free random id (request keys, nonces, mounts, sources). */
export function composeRandomId(): string {
	const bytes = new Uint8Array(12);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The seed keys that carry text or creation-time work (not the target). */
const TEXT_KEYS = [
	'prefillTo',
	'prefillCc',
	'prefillBcc',
	'prefillSubject',
	'prefillBodyHtml',
	'prefillBodyBlocks',
	'prefillComposerMode',
	'prefillFollowUpRemindAt',
] as const satisfies readonly (keyof ComposeSpec)[];
/** Run once, when the row is created; never again on a remount. */
const CREATION_KEYS = ['forwardAttachmentsFromMessageId', 'attachPendingKey'] as const;

/** Whether a seed carries text the server may not hold yet. */
export function seedCarriesText(seed: ComposeSpec | undefined): boolean {
	return !!seed && TEXT_KEYS.some((key) => seed[key] !== undefined);
}

/** The seed without the text keys (the server holds that text now). */
export function withoutSeedText(seed: ComposeSpec | undefined): ComposeSpec | undefined {
	if (!seed) return undefined;
	const rest: Record<string, unknown> = { ...seed };
	for (const key of TEXT_KEYS) delete rest[key];
	return rest as unknown as ComposeSpec;
}

/** The seed without the keys only a row's creation may act on. */
export function withoutCreationKeys(seed: ComposeSpec | undefined): ComposeSpec | undefined {
	if (!seed) return undefined;
	const rest: Record<string, unknown> = { ...seed };
	for (const key of CREATION_KEYS) delete rest[key];
	return rest as unknown as ComposeSpec;
}

/** True when `spec` names a saved draft and nothing else to prefill. */
function isDraftOnly(spec: ComposeSpec): boolean {
	const { mailboxId: _mailboxId, draftId, ...rest } = spec;
	return !!draftId && Object.values(rest).every((value) => value === undefined);
}

function storage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.sessionStorage;
	} catch {
		// Storage disabled (privacy mode): session state alone still covers
		// in-app navigation.
		return null;
	}
}

function isRequest(value: unknown): value is ComposeRequest {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { v?: unknown }).v === 1 &&
		typeof (value as { requestNonce?: unknown }).requestNonce === 'string' &&
		Array.isArray((value as { sources?: unknown }).sources)
	);
}

export function usePostboxComposeNav() {
	const requests = useState<Record<string, ComposeRequest>>('postbox:compose-requests', () => ({}));

	function write(key: string, request: ComposeRequest) {
		requests.value = { ...requests.value, [key]: request };
		try {
			storage()?.setItem(STORAGE_PREFIX + key, JSON.stringify(request));
		} catch {
			// Quota or serialization trouble: the in-memory copy still stands.
		}
	}

	function drop(key: string) {
		if (key in requests.value) {
			const { [key]: _dropped, ...rest } = requests.value;
			requests.value = rest;
		}
		try {
			storage()?.removeItem(STORAGE_PREFIX + key);
		} catch {
			// Nothing to clean up without storage.
		}
	}

	/** Forget requests past their lifetime (this tab's storage only). */
	function pruneExpired(now: number) {
		const store = storage();
		if (!store) return;
		try {
			for (let i = store.length - 1; i >= 0; i -= 1) {
				const key = store.key(i);
				if (!key?.startsWith(STORAGE_PREFIX)) continue;
				const request = parse(store.getItem(key));
				if (!request || now - request.createdAt > COMPOSE_REQUEST_TTL_MS) store.removeItem(key);
			}
		} catch {
			// Best effort.
		}
	}

	function parse(raw: string | null): ComposeRequest | null {
		if (!raw) return null;
		try {
			const value: unknown = JSON.parse(raw);
			return isRequest(value) ? value : null;
		} catch {
			return null;
		}
	}

	/** Make a request for `spec` and return its key (nothing navigates). */
	function create(spec: ComposeSpec): string {
		const now = Date.now();
		pruneExpired(now);
		const key = composeRandomId();
		const { mailboxId, draftId } = spec;
		write(key, {
			v: 1,
			createdAt: now,
			mountId: null,
			mailboxId,
			requestNonce: composeRandomId(),
			...(draftId ? { draftId } : {}),
			...(isDraftOnly(spec) ? {} : { seed: spec }),
			sources: [],
		});
		return key;
	}

	function open(spec: ComposeSpec) {
		const key = create(spec);
		// A saved draft also travels in the URL, so a copied link still opens it.
		const query = spec.draftId
			? { c: key, mailbox: spec.mailboxId, draft: spec.draftId }
			: { c: key };
		return navigateTo({ path: COMPOSE_PATH, query });
	}

	/** The request under `key`, or null when unknown or expired. */
	function read(key: string): ComposeRequest | null {
		const request = requests.value[key] ?? parse(storage()?.getItem(STORAGE_PREFIX + key) ?? null);
		if (!request) return null;
		if (Date.now() - request.createdAt > COMPOSE_REQUEST_TTL_MS) {
			drop(key);
			return null;
		}
		return request;
	}

	/**
	 * A request for a URL that names a saved draft but whose request this tab
	 * does not know (a copied link, another tab). Safe to make: it has a row, so
	 * its nonce never creates one.
	 */
	function adoptDraft(key: string, mailboxId: Id<'mailboxes'>, draftId: Id<'mailDrafts'>) {
		write(key, {
			v: 1,
			createdAt: Date.now(),
			mountId: null,
			mailboxId,
			requestNonce: composeRandomId(),
			draftId,
			sources: [],
		});
	}

	/** This page instance takes the request over; returns its mount id. */
	function claim(key: string): string | null {
		const request = read(key);
		if (!request) return null;
		const mountId = composeRandomId();
		write(key, { ...request, mountId });
		return mountId;
	}

	/**
	 * Change the request, only while `mountId` still owns it. `change` returns
	 * the new record (or null to leave it as it is). False when fenced off.
	 */
	function update(
		key: string,
		mountId: string,
		change: (request: ComposeRequest) => ComposeRequest | null
	): boolean {
		const request = read(key);
		if (!request || request.mountId !== mountId) return false;
		const next = change(request);
		if (next) write(key, next);
		return true;
	}

	/** The composition is over (sent, discarded): drop its request. */
	function forget(key: string, mountId: string) {
		const request = read(key);
		if (request && request.mountId === mountId) drop(key);
	}

	return { open, create, read, adoptDraft, claim, update, forget };
}
