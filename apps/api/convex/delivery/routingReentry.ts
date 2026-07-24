import { v } from 'convex/values';
import {
	GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
	MAX_GOVERNED_ROUTING_ATTEMPTS,
	ROUTING_REENTRY_TOKEN_MAX_LENGTH,
	ROUTING_REENTRY_TOKEN_TTL_MS,
} from '@owlat/shared';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { getOptional } from '../lib/env';
import type { SendRef } from './sendLifecycle/types';
import { campaignEmailPool, transactionalEmailPool } from './workpool';
import {
	envelopeInputValidator,
	retryStateValidator,
	type WorkerEnvelopeInput,
	type WorkerRetryState,
} from './workerEnvelope';

const TOKEN_PREFIX = 'rr2.';
const LEGACY_TOKEN_PREFIX = 'rr1.';
const TOKEN_AAD = new TextEncoder().encode('owlat-routing-reentry:v2');
const LEGACY_TOKEN_AAD = new TextEncoder().encode('owlat-routing-reentry:v1');

export const sendRefValidator = v.union(
	v.object({ kind: v.literal('campaign'), id: v.id('emailSends') }),
	v.object({ kind: v.literal('transactional'), id: v.id('transactionalSends') })
);

interface RoutingReentryTokenPayload {
	sendKind: 'campaign' | 'transactional';
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
	k: 'c' | 't';
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

function isLegacyCompactTokenPayload(value: unknown): value is LegacyCompactTokenPayload {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	return payload['v'] === 1 && isCompactTokenPayload({ ...payload, v: 2 });
}

function fromCompactTokenPayload(
	payload: CompactTokenPayload | LegacyCompactTokenPayload
): RoutingReentryTokenPayload {
	return {
		sendKind: payload.k === 'c' ? 'campaign' : 'transactional',
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
		k: payload.sendKind === 'campaign' ? 'c' : 't',
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

async function encryptToken(payload: RoutingReentryTokenPayload): Promise<string> {
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

async function decryptToken(token: string): Promise<RoutingReentryTokenPayload | null> {
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
		const now = Date.now();
		const ageMs = now - args.retryState.startedAt;
		if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= GOVERNED_MTA_MAX_MESSAGE_AGE_MS) {
			throw new Error('Routing re-entry deadline expired.');
		}
		const send = await ctx.db.get(args.sendRef.id);
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
		const expiresAt = Math.min(
			now + ROUTING_REENTRY_TOKEN_TTL_MS,
			args.retryState.startedAt + GOVERNED_MTA_MAX_MESSAGE_AGE_MS
		);
		const token = await encryptToken({
			sendKind: args.sendRef.kind,
			sendId: args.sendRef.id,
			organizationId: args.organizationId,
			messageId: args.messageId,
			workAttemptId: args.workAttemptId,
			attempt: args.retryState.attempt,
			expiresAt,
			callbackDigest: await callbackDigest(args.envelopeInput, args.retryState),
		});
		return { token, expiresAt };
	},
});

type ReentrySend = Doc<'emailSends'> | Doc<'transactionalSends'>;

interface ReentryTarget {
	sendRef: SendRef;
	send: ReentrySend;
	recordAttempt(): Promise<void>;
	enqueue(): Promise<void>;
}

type TargetResolution =
	| { ok: true; target: ReentryTarget }
	| { ok: false; disposition: 'binding_mismatch' | 'snapshot_not_found' };

/**
 * Resolve the token's table-specific Send once, then expose typed closures for
 * the only operations that differ between campaign and transactional rows.
 * The caller owns the shared lifecycle/CAS/deadline state machine.
 */
async function resolveReentryTarget(
	ctx: MutationCtx,
	payload: RoutingReentryTokenPayload,
	envelopeInput: WorkerEnvelopeInput,
	retryState: WorkerRetryState,
	messageId: string
): Promise<TargetResolution> {
	if (payload.sendKind === 'campaign') {
		const id = ctx.db.normalizeId('emailSends', payload.sendId);
		if (!id || envelopeInput.kind !== 'campaign' || envelopeInput.emailSendId !== id) {
			return { ok: false, disposition: 'binding_mismatch' };
		}
		const send = await ctx.db.get(id);
		if (!send) return { ok: false, disposition: 'snapshot_not_found' };
		return {
			ok: true,
			target: {
				sendRef: { kind: 'campaign', id },
				send,
				recordAttempt: async () => {
					await ctx.db.patch(id, {
						mtaRoutingReentryAttempt: payload.attempt,
						...(!send.providerMessageId
							? { providerMessageId: messageId, providerType: 'mta' }
							: {}),
					});
				},
				enqueue: async () => {
					await campaignEmailPool.enqueueAction(
						ctx,
						internal.delivery.worker.sendSingleEmail,
						{ envelopeInput, retryState },
						{
							onComplete: internal.delivery.sendCompletion.completeSend,
							context: { sendRef: { kind: 'campaign', id } },
						}
					);
				},
			},
		};
	}

	const id = ctx.db.normalizeId('transactionalSends', payload.sendId);
	if (!id || envelopeInput.kind !== 'transactional' || envelopeInput.sendId !== id) {
		return { ok: false, disposition: 'binding_mismatch' };
	}
	const send = await ctx.db.get(id);
	if (!send) return { ok: false, disposition: 'snapshot_not_found' };
	return {
		ok: true,
		target: {
			sendRef: { kind: 'transactional', id },
			send,
			recordAttempt: async () => {
				await ctx.db.patch(id, {
					mtaRoutingReentryAttempt: payload.attempt,
					...(!send.providerMessageId ? { providerMessageId: messageId, providerType: 'mta' } : {}),
				});
			},
			enqueue: async () => {
				await transactionalEmailPool.enqueueAction(
					ctx,
					internal.delivery.worker.sendSingleEmail,
					{ envelopeInput, retryState },
					{
						onComplete: internal.delivery.sendCompletion.completeSend,
						context: { sendRef: { kind: 'transactional', id } },
					}
				);
			},
		},
	};
}

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
			payload.messageId !== args.messageId ||
			payload.workAttemptId !== args.workAttemptId ||
			payload.attempt !== args.retryState.attempt ||
			payload.callbackDigest !== (await callbackDigest(args.envelopeInput, args.retryState)) ||
			args.retryState.idempotencyKey !== args.messageId ||
			args.envelopeInput.organizationId !== payload.organizationId
		) {
			return { disposition: 'binding_mismatch' as const };
		}
		const now = Date.now();
		const ageMs = now - args.retryState.startedAt;
		if (!Number.isFinite(ageMs) || ageMs < 0) {
			return { disposition: 'binding_mismatch' as const };
		}
		const deadlineExpired = ageMs >= GOVERNED_MTA_MAX_MESSAGE_AGE_MS;
		if (!deadlineExpired && payload.expiresAt <= now) return { disposition: 'expired' as const };

		const resolution = await resolveReentryTarget(
			ctx,
			payload,
			args.envelopeInput,
			args.retryState,
			args.messageId
		);
		if (!resolution.ok) return { disposition: resolution.disposition };
		const { sendRef, send, recordAttempt, enqueue } = resolution.target;
		if (send.status !== 'queued') return { disposition: 'terminal' as const };
		if (send.providerMessageId && send.providerMessageId !== args.messageId) {
			return { disposition: 'message_mismatch' as const };
		}
		if (deadlineExpired) {
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: sendRef,
				transition: {
					to: 'failed',
					at: now,
					errorCode: 'DELIVERY_DEADLINE_EXPIRED',
					errorMessage: 'Delivery exceeded the cumulative four-day routing deadline.',
				},
			});
			return { disposition: 'deadline_expired' as const };
		}
		if ((send.mtaRoutingReentryAttempt ?? 0) >= payload.attempt) {
			return { disposition: 'duplicate' as const };
		}
		await recordAttempt();
		if (payload.attempt > MAX_GOVERNED_ROUTING_ATTEMPTS) {
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: sendRef,
				transition: {
					to: 'failed',
					at: now,
					errorCode: 'ROUTING_RETRY_EXHAUSTED',
					errorMessage: 'Delivery routing changed after the final bounded attempt.',
				},
			});
			return { disposition: 'retry_exhausted' as const };
		}
		await enqueue();
		return { disposition: 'enqueued' as const, reason: args.reason };
	},
});
