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

export const releaseArtifact = internalMutation({
	args: {
		userId: v.string(),
		sessionId: v.id('accountExportSessions'),
		artifactId: v.id('accountExportArtifacts'),
	},
	handler: async (ctx, args): Promise<boolean> => {
		const session = await renewAccountExportSession(ctx, args.userId, args.sessionId);
		const artifact = await ctx.db.get(args.artifactId);
		if (!artifact || artifact.sessionId !== session._id) return false;
		await ctx.storage.delete(artifact.storageId);
		await ctx.db.delete(artifact._id);
		await ctx.db.patch(session._id, {
			artifactCount: Math.max(0, session.artifactCount - 1),
			artifactBytes: Math.max(0, session.artifactBytes - artifact.contentLength),
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
		if (existing) return { artifact: existing, created: false };
		if (
			session.artifactCount >= ACCOUNT_EXPORT_MAX_ARTIFACTS ||
			session.artifactBytes + args.contentLength > ACCOUNT_EXPORT_MAX_ARTIFACT_BYTES
		) {
			throw new Error('Account export staging quota exceeded');
		}
		const artifactId = await ctx.db.insert('accountExportArtifacts', {
			sessionId: session._id,
			artifactKey: args.artifactKey,
			storageId: args.storageId,
			contentLength: args.contentLength,
			createdAt: Date.now(),
		});
		await ctx.db.patch(session._id, {
			artifactCount: session.artifactCount + 1,
			artifactBytes: session.artifactBytes + args.contentLength,
		});
		const artifact = await ctx.db.get(artifactId);
		if (!artifact) throw new Error('Could not register account export artifact');
		return { artifact, created: true };
	},
});
