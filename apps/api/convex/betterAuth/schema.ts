// Local BetterAuth schema with organization plugin support.
// This schema includes the organization tables required for the organization plugin.
// The canonical base schema lives at
// `node_modules/@convex-dev/better-auth/src/component/schema.ts` — diff against
// that file when bumping `@convex-dev/better-auth`, then merge any new fields /
// tables into this file while preserving the organization plugin tables and
// `session.activeOrganizationId`.
//
// (Convex Local Install does not support `npx auth generate` here because our
// `auth.ts` is a factory that needs an `ActionCtx`. Diff the bundled schema
// instead.)

import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export const tables = {
	user: defineTable({
		name: v.string(),
		email: v.string(),
		emailVerified: v.boolean(),
		image: v.optional(v.union(v.null(), v.string())),
		createdAt: v.number(),
		updatedAt: v.number(),
		twoFactorEnabled: v.optional(v.union(v.null(), v.boolean())),
		isAnonymous: v.optional(v.union(v.null(), v.boolean())),
		username: v.optional(v.union(v.null(), v.string())),
		displayUsername: v.optional(v.union(v.null(), v.string())),
		phoneNumber: v.optional(v.union(v.null(), v.string())),
		phoneNumberVerified: v.optional(v.union(v.null(), v.boolean())),
		userId: v.optional(v.union(v.null(), v.string())),
	})
		.index('email_name', ['email', 'name'])
		.index('name', ['name'])
		.index('userId', ['userId'])
		.index('username', ['username'])
		.index('phoneNumber', ['phoneNumber']),
	session: defineTable({
		expiresAt: v.number(),
		token: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
		ipAddress: v.optional(v.union(v.null(), v.string())),
		userAgent: v.optional(v.union(v.null(), v.string())),
		userId: v.string(),
		// Organization plugin fields
		activeOrganizationId: v.optional(v.union(v.null(), v.string())),
	})
		.index('expiresAt', ['expiresAt'])
		.index('expiresAt_userId', ['expiresAt', 'userId'])
		.index('token', ['token'])
		.index('userId', ['userId']),
	account: defineTable({
		accountId: v.string(),
		providerId: v.string(),
		userId: v.string(),
		accessToken: v.optional(v.union(v.null(), v.string())),
		refreshToken: v.optional(v.union(v.null(), v.string())),
		idToken: v.optional(v.union(v.null(), v.string())),
		accessTokenExpiresAt: v.optional(v.union(v.null(), v.number())),
		refreshTokenExpiresAt: v.optional(v.union(v.null(), v.number())),
		scope: v.optional(v.union(v.null(), v.string())),
		password: v.optional(v.union(v.null(), v.string())),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('accountId', ['accountId'])
		.index('accountId_providerId', ['accountId', 'providerId'])
		.index('providerId_userId', ['providerId', 'userId'])
		.index('userId', ['userId']),
	verification: defineTable({
		identifier: v.string(),
		value: v.string(),
		expiresAt: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('expiresAt', ['expiresAt'])
		.index('identifier', ['identifier']),
	twoFactor: defineTable({
		secret: v.string(),
		backupCodes: v.string(),
		userId: v.string(),
		verified: v.optional(v.union(v.null(), v.boolean())),
	}).index('userId', ['userId']),
	passkey: defineTable({
		name: v.optional(v.union(v.null(), v.string())),
		publicKey: v.string(),
		userId: v.string(),
		credentialID: v.string(),
		counter: v.number(),
		deviceType: v.string(),
		backedUp: v.boolean(),
		transports: v.optional(v.union(v.null(), v.string())),
		createdAt: v.optional(v.union(v.null(), v.number())),
		aaguid: v.optional(v.union(v.null(), v.string())),
	})
		.index('credentialID', ['credentialID'])
		.index('userId', ['userId']),
	oauthApplication: defineTable({
		name: v.optional(v.union(v.null(), v.string())),
		icon: v.optional(v.union(v.null(), v.string())),
		metadata: v.optional(v.union(v.null(), v.string())),
		clientId: v.optional(v.union(v.null(), v.string())),
		clientSecret: v.optional(v.union(v.null(), v.string())),
		redirectUrls: v.optional(v.union(v.null(), v.string())),
		type: v.optional(v.union(v.null(), v.string())),
		disabled: v.optional(v.union(v.null(), v.boolean())),
		userId: v.optional(v.union(v.null(), v.string())),
		createdAt: v.optional(v.union(v.null(), v.number())),
		updatedAt: v.optional(v.union(v.null(), v.number())),
	})
		.index('clientId', ['clientId'])
		.index('userId', ['userId']),
	oauthAccessToken: defineTable({
		accessToken: v.optional(v.union(v.null(), v.string())),
		refreshToken: v.optional(v.union(v.null(), v.string())),
		accessTokenExpiresAt: v.optional(v.union(v.null(), v.number())),
		refreshTokenExpiresAt: v.optional(v.union(v.null(), v.number())),
		clientId: v.optional(v.union(v.null(), v.string())),
		userId: v.optional(v.union(v.null(), v.string())),
		scopes: v.optional(v.union(v.null(), v.string())),
		createdAt: v.optional(v.union(v.null(), v.number())),
		updatedAt: v.optional(v.union(v.null(), v.number())),
	})
		.index('accessToken', ['accessToken'])
		.index('refreshToken', ['refreshToken'])
		.index('clientId', ['clientId'])
		.index('userId', ['userId']),
	oauthConsent: defineTable({
		clientId: v.optional(v.union(v.null(), v.string())),
		userId: v.optional(v.union(v.null(), v.string())),
		scopes: v.optional(v.union(v.null(), v.string())),
		createdAt: v.optional(v.union(v.null(), v.number())),
		updatedAt: v.optional(v.union(v.null(), v.number())),
		consentGiven: v.optional(v.union(v.null(), v.boolean())),
	})
		.index('clientId_userId', ['clientId', 'userId'])
		.index('userId', ['userId']),
	jwks: defineTable({
		publicKey: v.string(),
		privateKey: v.string(),
		createdAt: v.number(),
		expiresAt: v.optional(v.union(v.null(), v.number())),
	}),
	rateLimit: defineTable({
		key: v.optional(v.union(v.null(), v.string())),
		count: v.optional(v.union(v.null(), v.number())),
		lastRequest: v.optional(v.union(v.null(), v.number())),
	}).index('key', ['key']),

	// ==========================================
	// Organization plugin tables
	// ==========================================
	organization: defineTable({
		name: v.string(),
		slug: v.optional(v.union(v.null(), v.string())),
		logo: v.optional(v.union(v.null(), v.string())),
		metadata: v.optional(v.union(v.null(), v.string())),
		createdAt: v.number(),
		updatedAt: v.optional(v.union(v.null(), v.number())),
	})
		.index('slug', ['slug'])
		.index('name', ['name']),
	member: defineTable({
		organizationId: v.string(),
		userId: v.string(),
		role: v.string(),
		createdAt: v.number(),
		updatedAt: v.optional(v.union(v.null(), v.number())),
	})
		.index('organizationId', ['organizationId'])
		.index('userId', ['userId'])
		.index('organizationId_userId', ['organizationId', 'userId']),
	invitation: defineTable({
		organizationId: v.string(),
		email: v.string(),
		role: v.string(),
		status: v.string(),
		expiresAt: v.number(),
		inviterId: v.string(),
		createdAt: v.optional(v.union(v.null(), v.number())),
		updatedAt: v.optional(v.union(v.null(), v.number())),
	})
		.index('organizationId', ['organizationId'])
		.index('email', ['email'])
		.index('status', ['status']),
};

const schema = defineSchema(tables);

export default schema;
