/**
 * App passwords for native IMAP/SMTP clients.
 *
 * Cleartext is generated server-side, displayed to the user ONCE in the
 * "show password" modal, then thrown away. Only a PBKDF2-SHA256 hash and
 * a 4-character prefix are persisted. The prefix narrows the candidate
 * set during login lookup so we only run the (intentionally slow) hash
 * compare against ≤ a few rows.
 *
 * Hashing uses WebCrypto's `PBKDF2` with 100k iterations of SHA-256 —
 * stays in the Convex v8 runtime (no `'use node'` overhead). For our
 * 16-character base32 password (80 bits of entropy) this is comfortably
 * above the brute-force threshold even with the iteration count.
 */

import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	internalAction,
} from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { requireAdminContext } from '../lib/sessionOrganization';
import { loadOwnedMailbox } from './permissions';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const PASSWORD_LENGTH = 16;

// Base32 alphabet (RFC 4648, no padding) — humans can copy-paste this
// without confusing 0/O/1/I.
const BASE32_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCleartextPassword(): string {
	const bytes = new Uint8Array(PASSWORD_LENGTH);
	crypto.getRandomValues(bytes);
	let out = '';
	for (let i = 0; i < PASSWORD_LENGTH; i++) {
		out += BASE32_ALPHABET[bytes[i]! % BASE32_ALPHABET.length];
	}
	return out;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.substr(i * 2, 2), 16);
	}
	return out;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: salt as unknown as ArrayBuffer,
			iterations: PBKDF2_ITERATIONS,
			hash: 'SHA-256',
		},
		key,
		HASH_BYTES * 8
	);
	return new Uint8Array(bits);
}

/** Encoded as `<salt-hex>:<hash-hex>` so iterations/algorithm are implicit. */
async function hashPassword(cleartext: string): Promise<string> {
	const salt = new Uint8Array(SALT_BYTES);
	crypto.getRandomValues(salt);
	const hash = await pbkdf2(cleartext, salt);
	return `${bytesToHex(salt)}:${bytesToHex(hash)}`;
}

async function verifyPassword(cleartext: string, encoded: string): Promise<boolean> {
	const [saltHex, hashHex] = encoded.split(':');
	if (!saltHex || !hashHex) return false;
	const salt = hexToBytes(saltHex);
	const expected = hexToBytes(hashHex);
	const got = await pbkdf2(cleartext, salt);
	if (got.length !== expected.length) return false;
	let mismatch = 0;
	for (let i = 0; i < got.length; i++) {
		mismatch |= got[i]! ^ expected[i]!;
	}
	return mismatch === 0;
}

// ── Public mutations ──────────────────────────────────────────────

/**
 * Generate a fresh app password. Returns the cleartext ONCE — the caller
 * MUST surface it to the user immediately because we never store it.
 */
export const generate = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		label: v.string(),
		scopes: v.optional(
			v.array(v.union(v.literal('imap'), v.literal('smtp')))
		),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const trimmed = args.label.trim();
		if (!trimmed) throwInvalidInput('Label required');

		const cleartext = generateCleartextPassword();
		const passwordHash = await hashPassword(cleartext);
		const passwordPrefix = cleartext.slice(0, 4).toLowerCase();

		const id = await ctx.db.insert('mailAppPasswords', {
			mailboxId: args.mailboxId,
			userId: owned.userId,
			label: trimmed,
			passwordHash,
			passwordPrefix,
			scopes: args.scopes ?? ['imap', 'smtp'],
			createdAt: Date.now(),
		});

		return { id, cleartext };
	},
});

// public: soft-auth — returns empty for anonymous; mailbox ownership is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) return [];
		const all = await ctx.db
			.query('mailAppPasswords')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect();
		// Hide the hash from the wire format
		return all.map((row) => ({
			_id: row._id,
			label: row.label,
			passwordPrefix: row.passwordPrefix,
			scopes: row.scopes,
			createdAt: row.createdAt,
			lastUsedAt: row.lastUsedAt,
			lastUsedIp: row.lastUsedIp,
			lastUsedUa: row.lastUsedUa,
			revokedAt: row.revokedAt,
		}));
	},
});

export const revoke = authedMutation({
	args: { appPasswordId: v.id('mailAppPasswords') },
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.appPasswordId);
		if (!row) return;
		const owned = await loadOwnedMailbox(ctx, row.mailboxId);
		if (!owned.ok) throwForbidden('Not accessible');
		await ctx.db.patch(args.appPasswordId, { revokedAt: Date.now() });
	},
});

/** Owner-level emergency: revoke ALL app passwords for a mailbox. */
export const revokeAll = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const all = await ctx.db
			.query('mailAppPasswords')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect();
		const now = Date.now();
		for (const row of all) {
			if (row.revokedAt) continue;
			await ctx.db.patch(row._id, { revokedAt: now });
		}
	},
});

// ── Internal API consumed by the IMAP server / SMTP submission ────

/**
 * Verify a (username=email, password=cleartext) credential pair.
 * Used by both the IMAP server (port 993) and the SMTP submission path.
 *
 * Returns null on auth failure. On success returns the bound mailbox +
 * app-password id so the caller can record session-level activity.
 */
export const verify = internalAction({
	args: {
		address: v.string(),
		password: v.string(),
		scope: v.union(v.literal('imap'), v.literal('smtp')),
		// Optional caller IP — used by the shared rate-limit table so the
		// SMTP submission path can throttle (the IMAP path also uses Redis).
		ip: v.optional(v.string()),
	},
	handler: async (
		ctx,
		args
	): Promise<{
		mailboxId: Id<'mailboxes'>;
		appPasswordId: Id<'mailAppPasswords'>;
		userId: string;
		organizationId: string;
	} | null> => {
		const lowerAddress = args.address.toLowerCase();

		// Cross-path throttle. The IMAP server has its own Redis sliding
		// window; this is the SMTP submission's equivalent — also catches
		// any future caller (e.g. the HMAC verify endpoint).
		const throttled = await ctx.runQuery(
			internal.mail.authRateLimit.isThrottled,
			{ address: lowerAddress, ip: args.ip }
		);
		if (throttled) {
			// Throttled callers look just like wrong-password failures.
			return null;
		}

		const candidates = await ctx.runQuery(
			internal.mail.appPasswords._candidatesByAddressAndPrefix,
			{
				address: lowerAddress,
				passwordPrefix: args.password.slice(0, 4).toLowerCase(),
				scope: args.scope,
			}
		);
		if (!candidates) {
			await ctx.runMutation(internal.mail.authRateLimit.recordFailure, {
				address: lowerAddress,
				ip: args.ip,
				scope: args.scope,
			});
			return null;
		}

		for (const candidate of candidates.rows) {
			if (candidate.revokedAt) continue;
			const ok = await verifyPassword(args.password, candidate.passwordHash);
			if (ok) {
				return {
					mailboxId: candidates.mailboxId,
					appPasswordId: candidate._id,
					userId: candidate.userId,
					organizationId: candidates.organizationId,
				};
			}
		}

		await ctx.runMutation(internal.mail.authRateLimit.recordFailure, {
			address: lowerAddress,
			ip: args.ip,
			scope: args.scope,
		});
		return null;
	},
});

export const _candidatesByAddressAndPrefix = internalQuery({
	args: {
		address: v.string(),
		passwordPrefix: v.string(),
		scope: v.union(v.literal('imap'), v.literal('smtp')),
	},
	handler: async (ctx, args) => {
		const mailbox = await ctx.db
			.query('mailboxes')
			.withIndex('by_address', (q) => q.eq('address', args.address))
			.first();
		if (!mailbox || mailbox.status !== 'active') return null;

		const rows = await ctx.db
			.query('mailAppPasswords')
			.withIndex('by_prefix', (q) => q.eq('passwordPrefix', args.passwordPrefix))
			.collect();

		// Narrow further by mailbox + scope
		const filtered = rows.filter(
			(r) =>
				r.mailboxId === mailbox._id &&
				r.scopes.includes(args.scope) &&
				!r.revokedAt
		);

		return {
			mailboxId: mailbox._id,
			organizationId: mailbox.organizationId,
			rows: filtered,
		};
	},
});

/** Update lastUsedAt/IP/UA after a successful auth (debounced by caller). */
export const touch = internalMutation({
	args: {
		appPasswordId: v.id('mailAppPasswords'),
		ip: v.optional(v.string()),
		userAgent: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.appPasswordId);
		if (!row || row.revokedAt) return;
		await ctx.db.patch(args.appPasswordId, {
			lastUsedAt: Date.now(),
			lastUsedIp: args.ip,
			lastUsedUa: args.userAgent,
		});
	},
});
