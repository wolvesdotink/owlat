import { v } from 'convex/values';
import {
	MAX_GOVERNED_ROUTING_ATTEMPTS,
	ROUTING_REENTRY_TOKEN_MAX_LENGTH,
	ROUTING_REENTRY_TOKEN_TTL_MS,
} from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { getOptional } from '../lib/env';
import { campaignEmailPool, transactionalEmailPool } from './workpool';
import { envelopeInputValidator, retryStateValidator } from './workerEnvelope';

const TOKEN_PREFIX = 'rr1.';
const TOKEN_AAD = new TextEncoder().encode('owlat-routing-reentry:v1');

export const sendRefValidator = v.union(
	v.object({ kind: v.literal('campaign'), id: v.id('emailSends') }),
	v.object({ kind: v.literal('transactional'), id: v.id('transactionalSends') })
);

interface TokenPayload {
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

function isTokenPayload(value: unknown): value is TokenPayload {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	return (
		Object.keys(payload).length === 9 &&
		payload['v'] === 1 &&
		(payload['k'] === 'c' || payload['k'] === 't') &&
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

async function encryptToken(payload: TokenPayload): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: TOKEN_AAD },
			await keyFromSecret(currentSecret()),
			new TextEncoder().encode(JSON.stringify(payload))
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

async function tryDecrypt(token: string, secret: string): Promise<TokenPayload | null> {
	const encoded = token.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : '';
	const bytes = base64UrlToBytes(encoded);
	if (!bytes || bytes.length <= 28) return null;
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: TOKEN_AAD },
			await keyFromSecret(secret),
			bytes.slice(12)
		);
		const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
		return isTokenPayload(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

async function decryptToken(token: string): Promise<TokenPayload | null> {
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

async function callbackDigest(envelopeInput: unknown, retryState: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalJson({ envelopeInput, retryState }))
	);
	return bytesToBase64Url(new Uint8Array(digest));
}

/** Issue a self-contained authenticated callback token after verifying its exact Send. */
export const issueSnapshot = internalMutation({
	args: {
		sendRef: sendRefValidator,
		organizationId: v.string(),
		messageId: v.string(),
		workAttemptId: v.string(),
		envelopeInput: envelopeInputValidator,
		retryState: retryStateValidator,
	},
	handler: async (ctx, args) => {
		const send =
			args.sendRef.kind === 'campaign'
				? await ctx.db.get(args.sendRef.id)
				: await ctx.db.get(args.sendRef.id);
		if (!send || send.status !== 'queued') {
			throw new Error('Routing re-entry token requires an existing queued Send.');
		}
		if (
			(args.envelopeInput.kind === 'campaign' &&
				(args.sendRef.kind !== 'campaign' || args.envelopeInput.emailSendId !== args.sendRef.id)) ||
			(args.envelopeInput.kind === 'transactional' &&
				(args.sendRef.kind !== 'transactional' || args.envelopeInput.sendId !== args.sendRef.id))
		) {
			throw new Error('Routing re-entry envelope does not belong to the Send.');
		}
		if (args.envelopeInput.organizationId !== args.organizationId) {
			throw new Error('Routing re-entry envelope does not belong to the organization.');
		}
		const expiresAt = Date.now() + ROUTING_REENTRY_TOKEN_TTL_MS;
		const token = await encryptToken({
			v: 1,
			k: args.sendRef.kind === 'campaign' ? 'c' : 't',
			i: args.sendRef.id,
			o: args.organizationId,
			m: args.messageId,
			w: args.workAttemptId,
			a: args.retryState.attempt,
			e: expiresAt,
			d: await callbackDigest(args.envelopeInput, args.retryState),
		});
		return { token, expiresAt };
	},
});

// Tokens are self-contained; a route that resolves away from MTA has no server state to discard.
export const discardSnapshot = internalMutation({
	args: { token: v.string() },
	handler: async () => undefined,
});

/** Decrypt, bind, and atomically advance the persisted attempt marker before enqueue. */
export const consumeSnapshot = internalMutation({
	args: {
		token: v.string(),
		messageId: v.string(),
		workAttemptId: v.string(),
		reason: v.union(
			v.literal('routing_lease_stale'),
			v.literal('circuit_breaker_changed'),
			v.literal('warming_capacity_changed')
		),
		envelopeInput: envelopeInputValidator,
		retryState: retryStateValidator,
	},
	handler: async (ctx, args) => {
		const payload = await decryptToken(args.token);
		if (!payload) return { disposition: 'invalid_token' as const };
		if (
			payload.m !== args.messageId ||
			payload.w !== args.workAttemptId ||
			payload.a !== args.retryState.attempt ||
			payload.d !== (await callbackDigest(args.envelopeInput, args.retryState)) ||
			args.retryState.idempotencyKey !== args.messageId ||
			args.envelopeInput.organizationId !== payload.o
		) {
			return { disposition: 'binding_mismatch' as const };
		}
		if (payload.e <= Date.now()) return { disposition: 'expired' as const };

		if (payload.k === 'c') {
			const id = ctx.db.normalizeId('emailSends', payload.i);
			if (!id || args.envelopeInput.kind !== 'campaign' || args.envelopeInput.emailSendId !== id) {
				return { disposition: 'binding_mismatch' as const };
			}
			const send = await ctx.db.get(id);
			if (!send) return { disposition: 'snapshot_not_found' as const };
			if (send.status !== 'queued') return { disposition: 'terminal' as const };
			if (send.providerMessageId && send.providerMessageId !== args.messageId) {
				return { disposition: 'message_mismatch' as const };
			}
			if ((send.mtaRoutingReentryAttempt ?? 0) >= payload.a) {
				return { disposition: 'duplicate' as const };
			}
			await ctx.db.patch(id, {
				mtaRoutingReentryAttempt: payload.a,
				...(!send.providerMessageId
					? { providerMessageId: args.messageId, providerType: 'mta' }
					: {}),
			});
			if (payload.a > MAX_GOVERNED_ROUTING_ATTEMPTS) {
				await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
					send: { kind: 'campaign', id },
					transition: {
						to: 'failed',
						at: Date.now(),
						errorCode: 'ROUTING_RETRY_EXHAUSTED',
						errorMessage: 'Delivery routing changed after the final bounded attempt.',
					},
				});
				return { disposition: 'retry_exhausted' as const };
			}
			await campaignEmailPool.enqueueAction(
				ctx,
				internal.delivery.worker.sendSingleEmail,
				{ envelopeInput: args.envelopeInput, retryState: args.retryState },
				{
					onComplete: internal.delivery.sendCompletion.completeSend,
					context: { sendRef: { kind: 'campaign', id } },
				}
			);
			return { disposition: 'enqueued' as const, reason: args.reason };
		}

		const id = ctx.db.normalizeId('transactionalSends', payload.i);
		if (!id || args.envelopeInput.kind !== 'transactional' || args.envelopeInput.sendId !== id) {
			return { disposition: 'binding_mismatch' as const };
		}
		const send = await ctx.db.get(id);
		if (!send) return { disposition: 'snapshot_not_found' as const };
		if (send.status !== 'queued') return { disposition: 'terminal' as const };
		if (send.providerMessageId && send.providerMessageId !== args.messageId) {
			return { disposition: 'message_mismatch' as const };
		}
		if ((send.mtaRoutingReentryAttempt ?? 0) >= payload.a) {
			return { disposition: 'duplicate' as const };
		}
		await ctx.db.patch(id, {
			mtaRoutingReentryAttempt: payload.a,
			...(!send.providerMessageId
				? { providerMessageId: args.messageId, providerType: 'mta' }
				: {}),
		});
		if (payload.a > MAX_GOVERNED_ROUTING_ATTEMPTS) {
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'transactional', id },
				transition: {
					to: 'failed',
					at: Date.now(),
					errorCode: 'ROUTING_RETRY_EXHAUSTED',
					errorMessage: 'Delivery routing changed after the final bounded attempt.',
				},
			});
			return { disposition: 'retry_exhausted' as const };
		}
		await transactionalEmailPool.enqueueAction(
			ctx,
			internal.delivery.worker.sendSingleEmail,
			{ envelopeInput: args.envelopeInput, retryState: args.retryState },
			{
				onComplete: internal.delivery.sendCompletion.completeSend,
				context: { sendRef: { kind: 'transactional', id } },
			}
		);
		return { disposition: 'enqueued' as const, reason: args.reason };
	},
});
