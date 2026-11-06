'use node';

/**
 * One CardDAV request and the reading of its answer, for the sync in
 * `contactsCardDavActions.ts`. Every request goes through the SSRF guard
 * (`fetchGuarded`) and every answer is read up to a byte cap. A request
 * refuses redirects unless the caller allows them, which only the
 * unauthenticated `/.well-known/carddav` probe does.
 */

import { CappedReadOverflow, fetchGuarded, readCappedBytes } from '../lib/ssrfGuard';
import type { CardDavErrorCode } from '../lib/validators/mailContacts';
import { parseMultistatus, type Multistatus } from './contactsCardDavProtocol';

/** One request; a slow server fails the step instead of holding the action. */
const REQUEST_TIMEOUT_MS = 20_000;

/** A failed step, with the reason the contacts page shows. */
export class CardDavError extends Error {
	readonly code: CardDavErrorCode;
	constructor(code: CardDavErrorCode) {
		super(code);
		this.code = code;
	}
}

export interface DavAnswer {
	status: number;
	text: string;
	url: string;
}

export function authHeader(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export async function davRequest(
	url: string,
	init: {
		method: 'PROPFIND' | 'REPORT';
		depth: '0' | '1';
		body: string;
		authorization?: string;
		maxBytes: number;
		maxRedirects?: number;
	}
): Promise<DavAnswer> {
	let response: Response;
	try {
		response = await fetchGuarded(url, {
			protocols: ['https:'],
			method: init.method,
			maxRedirects: init.maxRedirects ?? 0,
			headers: {
				'content-type': 'application/xml; charset=utf-8',
				accept: 'application/xml, text/xml',
				depth: init.depth,
				...(init.authorization ? { authorization: init.authorization } : {}),
			},
			body: init.body,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		// A refused destination (private address, redirect) reads to the user as
		// an unreachable server, like a DNS or socket failure.
		throw new CardDavError('unreachable');
	}
	if (response.status === 401 || response.status === 403) {
		const text = await readText(response, 64 * 1024).catch(() => '');
		return { status: response.status, text, url: response.url || url };
	}
	const text = await readText(response, init.maxBytes);
	return { status: response.status, text, url: response.url || url };
}

async function readText(response: Response, maxBytes: number): Promise<string> {
	try {
		const bytes = await readCappedBytes(response.body, maxBytes);
		return bytes ? new TextDecoder('utf-8').decode(bytes) : '';
	} catch (err) {
		if (err instanceof CappedReadOverflow) throw new CardDavError('too_large');
		throw new CardDavError('unreachable');
	}
}

/** A 207 answer read as multistatus; anything else is the step's failure. */
export function multistatusOf(answer: DavAnswer): Multistatus {
	if (answer.status === 401 || answer.status === 403) throw new CardDavError('auth');
	if (answer.status !== 207) throw new CardDavError('not_carddav');
	const status = parseMultistatus(answer.text, answer.url);
	if (!status) throw new CardDavError('not_carddav');
	return status;
}
