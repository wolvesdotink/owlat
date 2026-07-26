import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from '../_generated/server';
import { requireSelf } from '../lib/sessionOrganization';

const ACCOUNT_EXPORT_TTL_MS = 60 * 60 * 1_000;
const ACCOUNT_EXPORT_MAX_ARTIFACTS = 5_000;
const ACCOUNT_EXPORT_MAX_LEASES = 5_000;
const ACCOUNT_EXPORT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const ACCOUNT_EXPORT_CLEANUP_BATCH_SIZE = 25;

async function requireActiveAccountExportSession(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	sessionId: Id<'accountExportSessions'>
): Promise<Doc<'accountExportSessions'>> {
	await requireSelf(ctx, userId);
	const session = await ctx.db.get(sessionId);
	if (!session || session.userId !== userId || session.expiresAt <= Date.now()) {
		throw new Error('Account export session is missing or expired');
	}
	return session;
}

async function renewAccountExportSession(
	ctx: MutationCtx,
	userId: string,
	sessionId: Id<'accountExportSessions'>
): Promise<Doc<'accountExportSessions'>> {
	const session = await requireActiveAccountExportSession(ctx, userId, sessionId);
	await ctx.db.patch(session._id, { expiresAt: Date.now() + ACCOUNT_EXPORT_TTL_MS });
	return session;
}

export const beginSession = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, args): Promise<Id<'accountExportSessions'>> => {
		await requireSelf(ctx, args.userId);
		const now = Date.now();
		const sessions = await ctx.db
			.query('accountExportSessions')
			.withIndex('by_user_and_expires_at', (q) => q.eq('userId', args.userId))
			.order('desc')
			.take(4);
		const active = sessions.find((session) => session.expiresAt > now);
		if (active) {
			await ctx.db.patch(active._id, { expiresAt: now + ACCOUNT_EXPORT_TTL_MS });
			return active._id;
		}
		const expiresAt = now + ACCOUNT_EXPORT_TTL_MS;
		const sessionId = await ctx.db.insert('accountExportSessions', {
			userId: args.userId,
			artifactCount: 0,
			artifactBytes: 0,
			leaseCount: 0,
			createdAt: now,
			expiresAt,
		});
		await ctx.scheduler.runAt(expiresAt, internal.auth.accountExportArtifacts.expireSession, {
			sessionId,
		});
		return sessionId;
	},
});

export const expireSession = internalMutation({
	args: { sessionId: v.id('accountExportSessions') },
	handler: async (ctx, args): Promise<void> => {
		const session = await ctx.db.get(args.sessionId);
		if (!session) return;
		if (session.expiresAt > Date.now()) {
			await ctx.scheduler.runAt(
				session.expiresAt,
				internal.auth.accountExportArtifacts.expireSession,
				{ sessionId: session._id }
			);
			return;
		}
		const leases = await ctx.db
			.query('accountExportArtifactLeases')
			.withIndex('by_session', (q) => q.eq('sessionId', session._id))
			.take(ACCOUNT_EXPORT_CLEANUP_BATCH_SIZE);
		for (const lease of leases) await ctx.db.delete(lease._id);
		if (leases.length === ACCOUNT_EXPORT_CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.auth.accountExportArtifacts.expireSession, {
				sessionId: session._id,
			});
			return;
		}
		const artifacts = await ctx.db
			.query('accountExportArtifacts')
			.withIndex('by_session_and_key', (q) => q.eq('sessionId', session._id))
			.take(ACCOUNT_EXPORT_CLEANUP_BATCH_SIZE);
		for (const artifact of artifacts) {
			await ctx.storage.delete(artifact.storageId);
			await ctx.db.delete(artifact._id);
		}
		if (artifacts.length === ACCOUNT_EXPORT_CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.auth.accountExportArtifacts.expireSession, {
				sessionId: session._id,
			});
			return;
		}
		await ctx.db.delete(session._id);
	},
});

async function createArtifactLease(
	ctx: MutationCtx,
	session: Doc<'accountExportSessions'>,
	artifact: Doc<'accountExportArtifacts'>,
	leaseToken: string
): Promise<void> {
	const leaseCount = session.leaseCount ?? 0;
	if (leaseCount >= ACCOUNT_EXPORT_MAX_LEASES) {
		throw new Error('Account export staging quota exceeded');
	}
	const existingToken = await ctx.db
		.query('accountExportArtifactLeases')
		.withIndex('by_token', (q) => q.eq('leaseToken', leaseToken))
		.unique();
	if (existingToken) throw new Error('Account export artifact lease token collision');
	await ctx.db.insert('accountExportArtifactLeases', {
		sessionId: session._id,
		artifactId: artifact._id,
		leaseToken,
		createdAt: Date.now(),
	});
	await ctx.db.patch(artifact._id, {
		activeLeaseCount: (artifact.activeLeaseCount ?? 0) + 1,
	});
	await ctx.db.patch(session._id, { leaseCount: leaseCount + 1 });
}

export const findArtifact = internalQuery({
	args: {
		userId: v.string(),
		sessionId: v.id('accountExportSessions'),
		artifactKey: v.string(),
	},
	handler: async (ctx, args): Promise<Doc<'accountExportArtifacts'> | null> => {
		await requireActiveAccountExportSession(ctx, args.userId, args.sessionId);
		return ctx.db
			.query('accountExportArtifacts')
			.withIndex('by_session_and_key', (q) =>
				q.eq('sessionId', args.sessionId).eq('artifactKey', args.artifactKey)
			)
			.unique();
	},
});

export const validateActiveSession = internalMutation({
	args: {
		userId: v.string(),
		sessionId: v.id('accountExportSessions'),
	},
	handler: async (ctx, args): Promise<void> => {
		await renewAccountExportSession(ctx, args.userId, args.sessionId);
	},
});

export const acquireArtifactLease = internalMutation({
	args: {
		userId: v.string(),
		sessionId: v.id('accountExportSessions'),
		artifactId: v.id('accountExportArtifacts'),
		leaseToken: v.string(),
	},
	handler: async (ctx, args): Promise<Doc<'accountExportArtifacts'> | null> => {
		const session = await renewAccountExportSession(ctx, args.userId, args.sessionId);
		const artifact = await ctx.db.get(args.artifactId);
		if (!artifact || artifact.sessionId !== session._id) return null;
		await createArtifactLease(ctx, session, artifact, args.leaseToken);
		return artifact;
	},
});

export const releaseArtifact = internalMutation({
	args: {
		userId: v.string(),
		sessionId: v.id('accountExportSessions'),
		artifactId: v.id('accountExportArtifacts'),
		leaseToken: v.string(),
	},
	handler: async (ctx, args): Promise<boolean> => {
		const session = await renewAccountExportSession(ctx, args.userId, args.sessionId);
		const artifact = await ctx.db.get(args.artifactId);
		if (!artifact || artifact.sessionId !== session._id) return false;
		const lease = await ctx.db
			.query('accountExportArtifactLeases')
			.withIndex('by_token', (q) => q.eq('leaseToken', args.leaseToken))
			.unique();
		if (!lease || lease.sessionId !== session._id || lease.artifactId !== artifact._id) {
			return false;
		}
		await ctx.db.delete(lease._id);
		const remainingLeaseCount = Math.max(0, (artifact.activeLeaseCount ?? 1) - 1);
		if (remainingLeaseCount === 0) {
			await ctx.storage.delete(artifact.storageId);
			await ctx.db.delete(artifact._id);
		} else {
			await ctx.db.patch(artifact._id, { activeLeaseCount: remainingLeaseCount });
		}
		await ctx.db.patch(session._id, {
			leaseCount: Math.max(0, (session.leaseCount ?? 1) - 1),
			...(remainingLeaseCount === 0
				? {
						artifactCount: Math.max(0, session.artifactCount - 1),
						artifactBytes: Math.max(0, session.artifactBytes - artifact.contentLength),
					}
				: {}),
		});
		return true;
	},
});

export const registerArtifact = internalMutation({
	args: {
		userId: v.string(),
		sessionId: v.id('accountExportSessions'),
		artifactKey: v.string(),
		storageId: v.id('_storage'),
		contentLength: v.number(),
		leaseToken: v.string(),
	},
	handler: async (
		ctx,
		args
	): Promise<{ artifact: Doc<'accountExportArtifacts'>; created: boolean }> => {
		const session = await requireActiveAccountExportSession(ctx, args.userId, args.sessionId);
		const existing = await ctx.db
			.query('accountExportArtifacts')
			.withIndex('by_session_and_key', (q) =>
				q.eq('sessionId', args.sessionId).eq('artifactKey', args.artifactKey)
			)
			.unique();
		if (existing) {
			await createArtifactLease(ctx, session, existing, args.leaseToken);
			return { artifact: existing, created: false };
		}
		if (
			session.artifactCount >= ACCOUNT_EXPORT_MAX_ARTIFACTS ||
			(session.leaseCount ?? 0) >= ACCOUNT_EXPORT_MAX_LEASES ||
			session.artifactBytes + args.contentLength > ACCOUNT_EXPORT_MAX_ARTIFACT_BYTES
		) {
			throw new Error('Account export staging quota exceeded');
		}
		const existingToken = await ctx.db
			.query('accountExportArtifactLeases')
			.withIndex('by_token', (q) => q.eq('leaseToken', args.leaseToken))
			.unique();
		if (existingToken) throw new Error('Account export artifact lease token collision');
		const artifactId = await ctx.db.insert('accountExportArtifacts', {
			sessionId: session._id,
			artifactKey: args.artifactKey,
			storageId: args.storageId,
			contentLength: args.contentLength,
			activeLeaseCount: 1,
			createdAt: Date.now(),
		});
		await ctx.db.insert('accountExportArtifactLeases', {
			sessionId: session._id,
			artifactId,
			leaseToken: args.leaseToken,
			createdAt: Date.now(),
		});
		await ctx.db.patch(session._id, {
			artifactCount: session.artifactCount + 1,
			artifactBytes: session.artifactBytes + args.contentLength,
			leaseCount: (session.leaseCount ?? 0) + 1,
		});
		const artifact = await ctx.db.get(artifactId);
		if (!artifact) throw new Error('Could not register account export artifact');
		return { artifact, created: true };
	},
});
