'use node';

/**
 * CardDAV sync into the Postbox address book: the network half. `connect`
 * finds the address book behind a server URL and seals the password; `_sync`
 * reads what changed and hands it to the commits in `contactsCardDav.ts`.
 *
 * Every request goes through the SSRF guard (`contactsCardDavTransport.ts`),
 * so a server URL cannot reach a private or internal address, and every
 * answer is read up to a byte cap. Requests carrying the password refuse
 * redirects and stay on the origin discovery settled on (see
 * `contactsCardDavProtocol.ts`). Only the unauthenticated `/.well-known/carddav`
 * probe follows redirects.
 */

import { v } from 'convex/values';
import {
	parseVcards,
	VCARD_MAX_CARDS,
	VCARD_MAX_EMAILS_PER_CARD,
	type VcardContactEntry,
} from '@owlat/shared/postboxVcard';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalAction, type ActionCtx } from '../_generated/server';
import { authedAction } from '../lib/authedFunctions';
import { openCardDavPassword, sealCardDavPassword } from '../lib/credentialCrypto';
import { STRING_LIMITS, validateStringLength } from '../lib/inputGuards';
import type { CardDavErrorCode } from '../lib/validators/mailContacts';
import {
	PROPFIND_BOOKS_BODY,
	PROPFIND_CONTEXT_BODY,
	PROPFIND_CTAG_BODY,
	PROPFIND_ETAGS_BODY,
	PROPFIND_HOME_BODY,
	addressbookMultigetBody,
	hrefPath,
	isAddressBook,
	isInvalidSyncTokenError,
	listedCardEtags,
	multigetCards,
	normalizeServerUrl,
	parseMultistatus,
	propHref,
	propText,
	syncCollectionBody,
	syncReportChanges,
	wellKnownUrl,
	type CardChange,
} from './contactsCardDavProtocol';
import { CardDavError, authHeader, davRequest, multistatusOf } from './contactsCardDavTransport';

/** A discovery or listing answer. A listing of the largest book read fits. */
const MAX_LISTING_BYTES = 8 * 1024 * 1024;
/** A multiget answer: a chunk of cards, pictures included. */
const MAX_MULTIGET_BYTES = 16 * 1024 * 1024;
/** Cards one multiget asks for. */
const MULTIGET_CHUNK = 50;
/** Cards one commit writes. */
const COMMIT_CHUNK = 25;
/**
 * Removed cards one commit takes out. A card holds at most
 * VCARD_MAX_EMAILS_PER_CARD rows, so a commit deletes at most 500 rows and a
 * removal of the whole book persists its progress batch by batch.
 */
const REMOVED_CARDS_PER_COMMIT = Math.floor(500 / VCARD_MAX_EMAILS_PER_CARD);
/** Sync report rounds one sync follows when the server answers in parts. */
const MAX_SYNC_ROUNDS = 20;
/** Rows one known-cards read asks for. */
const KNOWN_CARDS_PAGE = 1_000;
const MAX_PASSWORD_LENGTH = 1_024;

/**
 * The context URL to start from: where the server's `/.well-known/carddav`
 * leads when the user typed a bare host, else the URL as typed.
 */
async function contextUrl(serverUrl: string): Promise<string> {
	const path = new URL(serverUrl).pathname;
	const probe = path === '/' || path === '' ? wellKnownUrl(serverUrl) : null;
	if (!probe) return serverUrl;
	try {
		const answer = await davRequest(probe, {
			method: 'PROPFIND',
			depth: '0',
			body: PROPFIND_CONTEXT_BODY,
			maxBytes: MAX_LISTING_BYTES,
			maxRedirects: 5,
		});
		// A server that answers the probe at all (207, or 401 asking for the
		// password) serves CardDAV where the redirects ended.
		if (answer.status === 207 || answer.status === 401) return answer.url;
	} catch {
		// No usable .well-known: the URL as typed is the context.
	}
	return serverUrl;
}

/** Find the address book: the context itself, or the first book in the principal's home. */
async function discoverAddressBook(
	serverUrl: string,
	authorization: string
): Promise<{ url: string; name?: string }> {
	const context = await contextUrl(serverUrl);
	const contextStatus = multistatusOf(
		await davRequest(context, {
			method: 'PROPFIND',
			depth: '0',
			body: PROPFIND_CONTEXT_BODY,
			authorization,
			maxBytes: MAX_LISTING_BYTES,
		})
	);
	const [self] = contextStatus.responses;
	if (self && isAddressBook(self)) {
		return { url: self.url, name: propText(self, 'displayname') ?? undefined };
	}
	const principal = (self && propHref(self, 'current-user-principal', context)) ?? context;
	const homeStatus = multistatusOf(
		await davRequest(principal, {
			method: 'PROPFIND',
			depth: '0',
			body: PROPFIND_HOME_BODY,
			authorization,
			maxBytes: MAX_LISTING_BYTES,
		})
	);
	const [principalSelf] = homeStatus.responses;
	const home =
		(principalSelf && propHref(principalSelf, 'addressbook-home-set', principal)) ?? principal;
	const books = multistatusOf(
		await davRequest(home, {
			method: 'PROPFIND',
			depth: '1',
			body: PROPFIND_BOOKS_BODY,
			authorization,
			maxBytes: MAX_LISTING_BYTES,
		})
	);
	const book = books.responses.find(isAddressBook);
	if (!book) throw new CardDavError('no_address_book');
	return { url: book.url, name: propText(book, 'displayname') ?? undefined };
}

/**
 * Connect a CardDAV address book to a mailbox: find the book, check the
 * credentials against it, seal the password and start the first sync.
 */
// authz: authedAction (authenticated member); mailbox access via
// internal._canConnect before any request and again in internal._insertAccount.
export const connect = authedAction({
	args: {
		mailboxId: v.id('mailboxes'),
		serverUrl: v.string(),
		username: v.string(),
		password: v.string(),
	},
	handler: async (
		ctx,
		args
	): Promise<
		| { ok: true }
		| { ok: false; reason: CardDavErrorCode | 'invalid_url' | 'forbidden' | 'already_connected' }
	> => {
		validateStringLength(args.serverUrl, STRING_LIMITS.URL, 'Server URL');
		validateStringLength(args.username, STRING_LIMITS.EMAIL, 'Username');
		validateStringLength(args.password, MAX_PASSWORD_LENGTH, 'Password');
		const allowed: { ok: true } | { ok: false; reason: 'forbidden' | 'already_connected' } =
			await ctx.runQuery(internal.mail.contactsCardDav._canConnect, { mailboxId: args.mailboxId });
		if (!allowed.ok) return allowed;
		const serverUrl = normalizeServerUrl(args.serverUrl);
		if (!serverUrl) return { ok: false, reason: 'invalid_url' };

		let book: { url: string; name?: string };
		try {
			book = await discoverAddressBook(serverUrl, authHeader(args.username.trim(), args.password));
		} catch (err) {
			return { ok: false, reason: err instanceof CardDavError ? err.code : 'failed' };
		}
		const sealed = sealCardDavPassword(args.password);
		return await ctx.runMutation(internal.mail.contactsCardDav._insertAccount, {
			mailboxId: args.mailboxId,
			serverUrl,
			addressBookUrl: book.url,
			addressBookName: book.name?.slice(0, 256),
			username: args.username.trim(),
			secretCiphertext: sealed.ciphertext,
			secretIv: sealed.iv,
			secretAuthTag: sealed.authTag,
			secretEnvelopeVersion: sealed.version,
		});
	},
});

/** What one sync found to do. */
interface SyncPlan {
	changed: Array<{ url: string; etag: string }>;
	removed: string[];
	syncToken?: string;
	ctag?: string;
	isTruncated: boolean;
}

/** The cards the book holds, by URL, with the etag each was written at. */
async function loadKnownCards(
	ctx: ActionCtx,
	accountId: Id<'mailCardDavAccounts'>
): Promise<Map<string, string>> {
	const known = new Map<string, string>();
	let cursor: string | null = null;
	for (;;) {
		const page: {
			page: Array<{ href: string; etag: string }>;
			isDone: boolean;
			continueCursor: string;
		} = await ctx.runQuery(internal.mail.contactsCardDav._knownCards, {
			accountId,
			paginationOpts: { cursor, numItems: KNOWN_CARDS_PAGE },
		});
		for (const card of page.page) known.set(card.href, card.etag);
		if (page.isDone) return known;
		cursor = page.continueCursor;
	}
}

/** The sync report, round after round; null when the server has none. */
async function syncReport(
	account: Doc<'mailCardDavAccounts'>,
	authorization: string
): Promise<{ changes: CardChange[]; syncToken: string | null; isFullListing: boolean } | null> {
	let token = account.syncToken ?? null;
	let isFullListing = token === null;
	const changes: CardChange[] = [];
	for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
		const answer = await davRequest(account.addressBookUrl, {
			method: 'REPORT',
			depth: '0',
			body: syncCollectionBody(token),
			authorization,
			maxBytes: MAX_LISTING_BYTES,
		});
		if (answer.status === 401) throw new CardDavError('auth');
		if (answer.status !== 207) {
			// An expired token: start over with a full listing.
			if (token !== null && isInvalidSyncTokenError(answer.text)) {
				token = null;
				isFullListing = true;
				changes.length = 0;
				continue;
			}
			if (round === 0) return null;
			throw new CardDavError('not_carddav');
		}
		const status = parseMultistatus(answer.text, answer.url);
		if (!status) throw new CardDavError('not_carddav');
		const part = syncReportChanges(status, account.addressBookUrl);
		changes.push(...part.changes);
		const next = status.syncToken;
		if (!part.isTruncated || !next || next === token)
			return { changes, syncToken: next, isFullListing };
		token = next;
	}
	throw new CardDavError('too_large');
}

/** For servers without the sync report: the change tag, then an etag listing. */
async function listingPlan(
	account: Doc<'mailCardDavAccounts'>,
	authorization: string,
	known: Map<string, string>
): Promise<SyncPlan> {
	const tagStatus = multistatusOf(
		await davRequest(account.addressBookUrl, {
			method: 'PROPFIND',
			depth: '0',
			body: PROPFIND_CTAG_BODY,
			authorization,
			maxBytes: MAX_LISTING_BYTES,
		})
	);
	const ctag = (tagStatus.responses[0] && propText(tagStatus.responses[0], 'getctag')) ?? undefined;
	if (ctag && ctag === account.ctag) {
		return { changed: [], removed: [], ctag, isTruncated: account.isTruncated === true };
	}
	const listing = listedCardEtags(
		multistatusOf(
			await davRequest(account.addressBookUrl, {
				method: 'PROPFIND',
				depth: '1',
				body: PROPFIND_ETAGS_BODY,
				authorization,
				maxBytes: MAX_LISTING_BYTES,
			})
		),
		account.addressBookUrl
	);
	const changed = [...listing]
		.filter(([url, etag]) => known.get(url) !== etag)
		.map(([url, etag]) => ({ url, etag }));
	const removed = [...known.keys()].filter((url) => !listing.has(url));
	return { changed, removed, ctag, isTruncated: false };
}

async function planSync(
	account: Doc<'mailCardDavAccounts'>,
	authorization: string,
	known: Map<string, string>
): Promise<SyncPlan> {
	const report = await syncReport(account, authorization);
	if (!report) return listingPlan(account, authorization, known);
	// Later entries for the same card win: a card changed, then removed, is removed.
	const latest = new Map<string, CardChange>();
	for (const change of report.changes) latest.set(change.url, change);
	const changed: Array<{ url: string; etag: string }> = [];
	const removed: string[] = [];
	for (const change of latest.values()) {
		if (change.kind === 'removed') {
			if (known.has(change.url)) removed.push(change.url);
		} else if (known.get(change.url) !== change.etag) {
			changed.push({ url: change.url, etag: change.etag });
		}
	}
	// A full listing names every card, so a card it leaves out is gone.
	if (report.isFullListing) {
		for (const url of known.keys()) if (!latest.has(url)) removed.push(url);
	}
	return { changed, removed, syncToken: report.syncToken ?? undefined, isTruncated: false };
}

type SyncedEntry = { entry: Omit<VcardContactEntry, 'photo'>; photoStorageId?: Id<'_storage'> };

/** Parse one card and store its picture; the commit decides whether a row keeps it. */
async function cardEntries(ctx: ActionCtx, vcard: string): Promise<SyncedEntry[]> {
	const { entries } = parseVcards(vcard);
	const synced: SyncedEntry[] = [];
	for (const { photo, ...entry } of entries) {
		let photoStorageId: Id<'_storage'> | undefined;
		if (photo) {
			const bytes = Buffer.from(photo.base64, 'base64');
			photoStorageId = await ctx.storage.store(new Blob([bytes], { type: photo.mediaType }));
		}
		synced.push({ entry, photoStorageId });
	}
	return synced;
}

/**
 * Take the removed cards out, then fetch the changed cards in chunks and
 * commit them, one checkpoint per batch. Stops as soon as a commit finds the
 * run no longer holds the account.
 */
async function fetchAndApply(
	ctx: ActionCtx,
	account: Doc<'mailCardDavAccounts'>,
	runToken: string,
	authorization: string,
	plan: SyncPlan
): Promise<{ isStopped: boolean }> {
	const pending: Array<{ href: string; etag: string; entries: SyncedEntry[] }> = [];
	const removed = [...plan.removed];
	const commit = async (): Promise<boolean> => {
		const changed = pending.splice(0, pending.length);
		const removedHrefs = removed.splice(0, REMOVED_CARDS_PER_COMMIT);
		if (changed.length === 0 && removedHrefs.length === 0) return false;
		// checkpoint: one page of an idempotent sync; the next sync redoes what a failure leaves.
		const result = await ctx.runMutation(internal.mail.contactsCardDav._applyChanges, {
			accountId: account._id,
			runToken,
			changed,
			removedHrefs,
		});
		return result.isStopped;
	};
	while (removed.length > 0) {
		if (await commit()) return { isStopped: true };
	}
	for (let start = 0; start < plan.changed.length; start += MULTIGET_CHUNK) {
		const chunk = plan.changed.slice(start, start + MULTIGET_CHUNK);
		const status = multistatusOf(
			await davRequest(account.addressBookUrl, {
				method: 'REPORT',
				depth: '1',
				body: addressbookMultigetBody(chunk.map((card) => hrefPath(card.url))),
				authorization,
				maxBytes: MAX_MULTIGET_BYTES,
			})
		);
		for (const card of multigetCards(status)) {
			pending.push({
				href: card.url,
				etag: card.etag,
				entries: await cardEntries(ctx, card.vcard),
			});
			if (pending.length >= COMMIT_CHUNK && (await commit())) return { isStopped: true };
		}
	}
	return { isStopped: await commit() };
}

/** Read what changed in an account's book and write it into the mailbox's address book. */
export const _sync = internalAction({
	args: { accountId: v.id('mailCardDavAccounts') },
	handler: async (ctx, args) => {
		const runToken = crypto.randomUUID();
		// checkpoint: the claim stands alone; `_finishSync` releases it, or it lapses.
		const account: Doc<'mailCardDavAccounts'> | null = await ctx.runMutation(
			internal.mail.contactsCardDav._claimSync,
			{ accountId: args.accountId, runToken }
		);
		// Gone, or another run holds it: that run reads what this one would have.
		if (!account) return;
		type Outcome =
			| { ok: true; syncToken?: string; ctag?: string; isTruncated: boolean }
			| { ok: false; errorCode: CardDavErrorCode };
		let outcome: Outcome;
		try {
			const password = openCardDavPassword({
				ciphertext: account.secretCiphertext,
				iv: account.secretIv,
				authTag: account.secretAuthTag,
				version: account.secretEnvelopeVersion,
			});
			const authorization = authHeader(account.username, password);
			const known = await loadKnownCards(ctx, account._id);
			const plan = await planSync(account, authorization, known);
			const isTruncated = plan.isTruncated || plan.changed.length > VCARD_MAX_CARDS;
			plan.changed = plan.changed.slice(0, VCARD_MAX_CARDS);
			const applied = await fetchAndApply(ctx, account, runToken, authorization, plan);
			if (applied.isStopped) return;
			outcome = { ok: true, syncToken: plan.syncToken, ctag: plan.ctag, isTruncated };
		} catch (err) {
			outcome = { ok: false, errorCode: err instanceof CardDavError ? err.code : 'failed' };
		}
		await ctx.runMutation(internal.mail.contactsCardDav._finishSync, {
			accountId: account._id,
			runToken,
			outcome,
		});
	},
});
