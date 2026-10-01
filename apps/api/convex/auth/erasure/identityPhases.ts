/**
 * The authentication identity — the BetterAuth component rows of the member
 * being erased (issue #941).
 *
 * Deleting the Owlat profile and memberships is not deleting the account: the
 * login identity (`user`), the password hash (`account`), live `session`s,
 * passkeys and TOTP secrets all live in the BetterAuth component. The
 * `/delete-user` endpoint is disabled on this instance (auth/auth.ts), so this
 * erasure is the only path that removes them.
 *
 * Order: the `user` row goes in the transaction that starts the erasure
 * (`revokeIdentity`). BetterAuth resolves a session by joining its user, so
 * every existing session stops resolving at that moment and no sign-in path
 * can find the identity again. The phases below then remove the rows that
 * still carry its id, a bounded page at a time.
 *
 * All deletes go through the component's own adapter (`deleteMany` /
 * `deleteOne`), the same functions BetterAuth's internal adapter uses. This
 * instance registers no component triggers and no `databaseHooks` for these
 * models, so there is no plugin cleanup to run alongside them.
 *
 * Kept on purpose (declared in `relations.ts`): invitations the member SENT
 * (`inviterId`, the organization's record), pending invitations addressed to
 * the email (the organization's standing intent for that address), `jwks` and
 * `rateLimit` (instance-level, keyed by nothing personal).
 */

import { components } from '../../_generated/api';
import type { MutationCtx } from '../../_generated/server';
import type { ErasureBudget } from '../../contacts/erasure/budget';
import type { MemberPhaseContext, MemberPhaseOutcome, MemberPhaseRunner } from './phaseKit';

/** Rows per component call. */
const IDENTITY_PAGE = 64;
/**
 * What one component row is charged against the byte budget. The component
 * returns only ids, so the size is estimated: these rows hold ids, hashes,
 * timestamps and one request header (a session's user agent), well under this.
 */
const IDENTITY_ROW_BYTES = 16 * 1024;

/** The component models keyed by the user id that the erasure deletes. */
type UserKeyedModel =
	| 'session'
	| 'account'
	| 'passkey'
	| 'twoFactor'
	| 'member'
	| 'oauthAccessToken'
	| 'oauthConsent'
	| 'oauthApplication';

/** The models that must be empty for the member when the erasure completes. */
export const IDENTITY_MODELS_CHECKED: readonly UserKeyedModel[] = [
	'session',
	'account',
	'passkey',
	'twoFactor',
	'member',
];

function identityChunk(budget: ErasureBudget): number {
	const affordable = Math.floor(budget.bytesLeft / IDENTITY_ROW_BYTES);
	return Math.max(1, Math.min(budget.pageRows(IDENTITY_PAGE), affordable));
}

/** Delete the member's rows of one model, a page at a time. Returns whether none are left. */
async function deleteUserRows(phase: MemberPhaseContext, model: UserKeyedModel): Promise<boolean> {
	const { ctx, budget, authUserId } = phase;
	while (!budget.isExhausted) {
		const numItems = identityChunk(budget);
		const result = await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
			input: { model, where: [{ field: 'userId', value: authUserId }] },
			paginationOpts: { cursor: null, numItems },
		} as never);
		const { count, isDone } = result as { count: number; isDone: boolean };
		budget.chargeRows(count);
		budget.chargeBytes(Math.max(1, count) * IDENTITY_ROW_BYTES);
		if (isDone || count < numItems) return true;
	}
	return false;
}

function deleteModels(models: readonly UserKeyedModel[]): MemberPhaseRunner {
	return async (phase) => {
		for (const model of models) {
			if (!(await deleteUserRows(phase, model))) return { isDone: false };
		}
		return { isDone: true };
	};
}

/**
 * Remove the login identity itself. Every session resolves through it, so this
 * is what makes existing sessions unusable; run in the transaction that starts
 * the erasure. Idempotent: an identity already gone is a no-op.
 */
export async function revokeIdentity(ctx: MutationCtx, authUserId: string): Promise<void> {
	await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
		input: { model: 'user', where: [{ field: '_id', value: authUserId }] },
	});
}

/** Sessions — possibly a long history of them. */
export const eraseSessions: MemberPhaseRunner = deleteModels(['session']);

/**
 * Credentials and memberships: the password `account` rows (and any linked
 * provider), passkeys, the TOTP secret and backup codes, and any organization
 * membership still naming the id.
 */
export const eraseCredentials: MemberPhaseRunner = deleteModels([
	'account',
	'passkey',
	'twoFactor',
	'member',
]);

/**
 * OAuth-provider grants. The provider plugin is not enabled on this instance,
 * so these are normally empty; they are keyed by the user and hold tokens, so
 * the erasure clears them rather than rely on that.
 */
export const eraseOAuthGrants: MemberPhaseRunner = deleteModels([
	'oauthAccessToken',
	'oauthConsent',
	'oauthApplication',
]);

interface VerificationRow {
	_id: string;
	identifier: string;
	value: string;
	expiresAt: number;
}

/**
 * Unexpired verification records that name the member: a password-reset token
 * stores the user id as its value, and address-bound flows use the email as the
 * identifier. Redeeming a stale reset token would otherwise write a fresh
 * credential row for the erased id. Expired rows are dead already. Pages through
 * the live range with a saved cursor, one page per transaction, since the rows
 * of other people stay where they are.
 */
export const eraseVerifications: MemberPhaseRunner = async (phase): Promise<MemberPhaseOutcome> => {
	const { ctx, budget, authUserId, cursor } = phase;
	const email = phase.email.toLowerCase();
	const numItems = identityChunk(budget);
	const page = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'verification',
		where: [{ field: 'expiresAt', operator: 'gt', value: Date.now() }],
		paginationOpts: { cursor: cursor ?? null, numItems },
	} as never)) as { page: VerificationRow[]; continueCursor: string; isDone: boolean };
	for (const row of page.page) {
		budget.charge(row);
		const namesMember =
			row.value === authUserId ||
			row.value.includes(authUserId) ||
			row.identifier.toLowerCase().includes(email);
		if (!namesMember) continue;
		await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
			input: { model: 'verification', where: [{ field: '_id', value: row._id }] },
		} as never);
	}
	return page.isDone ? { isDone: true } : { isDone: false, cursor: page.continueCursor };
};

interface InvitationRow {
	_id: string;
	email: string;
	status: string;
}

/**
 * Invitations addressed to the member that were decided (accepted, rejected,
 * cancelled). They are the member's onboarding record and carry the address.
 * A still-pending one is the organization's current intent for the address and
 * stays until an admin revokes it or it expires.
 */
export const eraseInvitations: MemberPhaseRunner = async (phase): Promise<MemberPhaseOutcome> => {
	const { ctx, budget, cursor } = phase;
	const page = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'invitation',
		where: [{ field: 'email', value: phase.email.toLowerCase() }],
		paginationOpts: { cursor: cursor ?? null, numItems: identityChunk(budget) },
	} as never)) as { page: InvitationRow[]; continueCursor: string; isDone: boolean };
	for (const invitation of page.page) {
		budget.charge(invitation);
		if (invitation.status === 'pending') continue;
		await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
			input: { model: 'invitation', where: [{ field: '_id', value: invitation._id }] },
		} as never);
	}
	return page.isDone ? { isDone: true } : { isDone: false, cursor: page.continueCursor };
};

/**
 * The identity rows still present for the member: the `user` row and every
 * model in `IDENTITY_MODELS_CHECKED`. Empty when the identity is fully gone.
 */
export async function remainingIdentityRows(
	ctx: MutationCtx,
	authUserId: string
): Promise<string[]> {
	const remaining: string[] = [];
	const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: 'user',
		where: [{ field: '_id', value: authUserId }],
	});
	if (user) remaining.push('user');
	for (const model of IDENTITY_MODELS_CHECKED) {
		const rows = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
			model,
			where: [{ field: 'userId', value: authUserId }],
			paginationOpts: { cursor: null, numItems: 1 },
		} as never)) as { page: unknown[] };
		if (rows.page.length > 0) remaining.push(model);
	}
	return remaining;
}
