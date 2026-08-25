/**
 * THE ROUTING RE-ENTRY TOKEN CODEC.
 *
 * A self-contained authenticated bearer token: the governed dispatch boundary
 * hands one to the MTA, and the MTA hands it back on a routing callback. Nothing
 * about a Send is looked up to read it — the token IS the binding — so the codec
 * owes no database access and keeps none. It sits beside `routingReentry.ts`
 * (which owns the two Convex mutations that issue and consume a token) rather
 * than inside it: the wire format, its rolling legacy decoder and the AES-GCM
 * envelope change on a different clock than the lifecycle rules that trust them.
 *
 * Everything here is bytes-and-crypto. The domain shape it produces is
 * `RoutingReentryTokenPayload`; the compact `v/k/i/o/m/w/a/e/d` names exist only
 * to keep an encrypted token inside `ROUTING_REENTRY_TOKEN_MAX_LENGTH` and must
 * never leak into domain logic.
 */

import { ROUTING_REENTRY_TOKEN_MAX_LENGTH } from '@owlat/shared';
import { getOptional } from '../lib/env';

const TOKEN_PREFIX = 'rr2.';
const LEGACY_TOKEN_PREFIX = 'rr1.';
const TOKEN_AAD = new TextEncoder().encode('owlat-routing-reentry:v2');
const LEGACY_TOKEN_AAD = new TextEncoder().encode('owlat-routing-reentry:v1');

export interface RoutingReentryTokenPayload {
	sendKind: 'campaign' | 'transactional' | 'seedProbe';
	sendId: string;
	organizationId: string;
	messageId: string;
	workAttemptId: string;
	attempt: number;
	expiresAt: number;
	callbackDigest: string;
}

/** Compact encrypted wire representation. Opaque names do not enter domain logic. */
interface CompactTokenPayload {
	v: 2;
	k: 'c' | 't' | 's';
	i: string;
	o: string;
	m: string;
	w: string;
	a: number;
	e: number;
	d: string;
}

/** Rolling decoder for tokens issued by the previous rr1 deployment. */
interface LegacyCompactTokenPayload {
	v: 1;
	k: 'c' | 't';
	i: string;
	o: string;
	m: string;
	w: string;
	a: number;
	e: number;
	d: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
	try {
		const padded = value
			.replaceAll('-', '+')
			.replaceAll('_', '/')
			.padEnd(Math.ceil(value.length / 4) * 4, '=');
		const binary = atob(padded);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

function isCompactTokenPayload(value: unknown): value is CompactTokenPayload {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	return (
		Object.keys(payload).length === 9 &&
		payload['v'] === 2 &&
		(payload['k'] === 'c' || payload['k'] === 't' || payload['k'] === 's') &&
		typeof payload['i'] === 'string' &&
		typeof payload['o'] === 'string' &&
		typeof payload['m'] === 'string' &&
		typeof payload['w'] === 'string' &&
		typeof payload['a'] === 'number' &&
		Number.isInteger(payload['a']) &&
		payload['a'] >= 1 &&
		typeof payload['e'] === 'number' &&
		Number.isFinite(payload['e']) &&
		typeof payload['d'] === 'string' &&
		payload['d'].length === 43
	);
}

function isLegacyCompactTokenPayload(value: unknown): value is LegacyCompactTokenPayload {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	// rr1 never issued a seed-probe token; only 'c'/'t' are decodable there.
	if (payload['k'] !== 'c' && payload['k'] !== 't') return false;
	return payload['v'] === 1 && isCompactTokenPayload({ ...payload, v: 2 });
}

function fromCompactTokenPayload(
	payload: CompactTokenPayload | LegacyCompactTokenPayload
): RoutingReentryTokenPayload {
	return {
		sendKind: payload.k === 'c' ? 'campaign' : payload.k === 's' ? 'seedProbe' : 'transactional',
		sendId: payload.i,
		organizationId: payload.o,
		messageId: payload.m,
		workAttemptId: payload.w,
		attempt: payload.a,
		expiresAt: payload.e,
		callbackDigest: payload.d,
	};
}

function toCompactTokenPayload(payload: RoutingReentryTokenPayload): CompactTokenPayload {
	return {
		v: 2,
		k: payload.sendKind === 'campaign' ? 'c' : payload.sendKind === 'seedProbe' ? 's' : 't',
		i: payload.sendId,
		o: payload.organizationId,
		m: payload.messageId,
		w: payload.workAttemptId,
		a: payload.attempt,
		e: payload.expiresAt,
		d: payload.callbackDigest,
	};
}

async function keyFromSecret(secret: string): Promise<CryptoKey> {
	const keyBytes = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`owlat-routing-reentry-key-v1\0${secret}`)
	);
	return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function currentSecret(): string {
	const secret = getOptional('INSTANCE_SECRET');
	if (!secret || secret.length < 32) {
		throw new Error('INSTANCE_SECRET must contain at least 32 characters for routing re-entry.');
	}
	return secret;
}

export async function encryptToken(payload: RoutingReentryTokenPayload): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: TOKEN_AAD },
			await keyFromSecret(currentSecret()),
			new TextEncoder().encode(JSON.stringify(toCompactTokenPayload(payload)))
		)
	);
	const combined = new Uint8Array(iv.length + ciphertext.length);
	combined.set(iv);
	combined.set(ciphertext, iv.length);
	const token = `${TOKEN_PREFIX}${bytesToBase64Url(combined)}`;
	if (token.length > ROUTING_REENTRY_TOKEN_MAX_LENGTH) {
		throw new Error('Routing re-entry token exceeds its transport bound.');
	}
	return token;
}

async function tryDecrypt(
	token: string,
	secret: string
): Promise<RoutingReentryTokenPayload | null> {
	const isCurrent = token.startsWith(TOKEN_PREFIX);
	const isLegacy = token.startsWith(LEGACY_TOKEN_PREFIX);
	if (!isCurrent && !isLegacy) return null;
	const prefix = isCurrent ? TOKEN_PREFIX : LEGACY_TOKEN_PREFIX;
	const additionalData = isCurrent ? TOKEN_AAD : LEGACY_TOKEN_AAD;
	const encoded = token.slice(prefix.length);
	const bytes = base64UrlToBytes(encoded);
	if (!bytes || bytes.length <= 28) return null;
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData },
			await keyFromSecret(secret),
			bytes.slice(12)
		);
		const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
		if (isCurrent && isCompactTokenPayload(parsed)) return fromCompactTokenPayload(parsed);
		if (isLegacy && isLegacyCompactTokenPayload(parsed)) return fromCompactTokenPayload(parsed);
		return null;
	} catch {
		return null;
	}
}

export async function decryptToken(token: string): Promise<RoutingReentryTokenPayload | null> {
	if (token.length > ROUTING_REENTRY_TOKEN_MAX_LENGTH) return null;
	const payload = await tryDecrypt(token, currentSecret());
	if (payload) return payload;
	const previous = getOptional('INSTANCE_SECRET_PREVIOUS');
	return previous && previous.length >= 32 ? tryDecrypt(token, previous) : null;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}

/**
 * The token's tamper-evident binding to the exact envelope it was issued for.
 * Key order is canonicalized so an identical envelope always digests identically
 * across the issue and the callback.
 */
export async function callbackDigest(envelopeInput: unknown, retryState: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalJson({ envelopeInput, retryState }))
	);
	return bytesToBase64Url(new Uint8Array(digest));
}
