/**
 * Return-type redaction gate: no public Convex function may return a
 * capability secret, however the row was loaded.
 *
 * `scripts/check-token-redaction.sh` greps for inline `.query('<table>')` scans
 * inside public query spans. It cannot see a row that arrives through a helper
 * or an id read — `batchGet(ctx, ids)`, `ctx.db.get(thread.contactId)`,
 * `getOrThrow(...)` — which is how `contacts.relationships.listByContact`
 * shipped whole related-contact rows, pending DOI token included. A grep cannot
 * tell which table an id belongs to, or whether the handler projected the row
 * before returning it; the compiler can. So this gate works off the generated
 * `api` object: it walks every public query, mutation and action, takes the
 * declared return type (what Convex serializes to the caller) and fails when a
 * capability field is reachable in it. A handler that runs its rows through
 * `redactContactCapabilityFields` / `stripWebhookSecret`, or projects to a
 * narrow shape, passes without annotation.
 *
 * The check is type-level, so it is enforced by `turbo typecheck` (this file is
 * part of the Convex tsconfig), not by the vitest run; `expectTypeOf` and the
 * `const` assignments below are runtime no-ops.
 *
 * Blind spot: a field typed `any` carries no structure to inspect. A whole
 * namespace or function typed `any` is caught (see the second case) — that is
 * what a stale `_generated/api.d.ts` entry for a deleted module does to every
 * sibling in its directory.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { api } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { PublicContact } from '../../contacts/listing';

/**
 * Public functions allowed to return a capability field, each with the reason.
 * Strict both ways: an entry whose function stops returning the field fails too,
 * so the list only shrinks.
 */
type ReviewedExceptions =
	// Held to `shareLinks:manage`; the share popover builds the copyable URL
	// from the token, so here the token is the payload rather than a leak.
	'shareLinks.listShareLinks';

/**
 * Per table, the fields that are a bearer capability (the same four tables the
 * grep gate covers). Contact and API-key field names are unique across the
 * schema, so they are flagged wherever they occur. `token` and `secret` are
 * generic words, so those two are flagged only on an object that still carries
 * its source table's `_id` — a row, or a row spread — rather than an unrelated
 * shape that happens to reuse the word.
 */
type UniqueCapabilityField = 'doiConfirmationToken' | 'doiTokenExpiresAt' | 'keyHash';
type RowCapabilityField = {
	shareLinks: 'token';
	webhooks: 'secret';
};

/** Return shapes are shallow; the bound keeps the walk cheap and cycle-proof. */
type MaxDepth = 8;

type IsAny<T> = 0 extends 1 & T ? true : false;

type LeaksAtThisLevel<T> = [Extract<keyof T, UniqueCapabilityField>] extends [never]
	? {
			[Table in keyof RowCapabilityField]: T extends { _id: Id<Table> }
				? RowCapabilityField[Table] extends keyof T
					? true
					: never
				: never;
		}[keyof RowCapabilityField]
	: true;

/**
 * `true` when a capability field is reachable anywhere in `T`. Distributes over
 * unions (a nullable or discriminated return leaks if any branch does); arrays
 * and records are walked element- and value-wise.
 */
type Leaks<T, Depth extends unknown[] = []> = Depth['length'] extends MaxDepth
	? never
	: IsAny<T> extends true
		? never
		: T extends string | number | boolean | bigint | symbol | null | undefined | ArrayBuffer
			? never
			: T extends ReadonlyArray<infer Element>
				? Leaks<Element, [...Depth, unknown]>
				: T extends object
					? LeaksAtThisLevel<T> | { [K in keyof T]-?: Leaks<T[K], [...Depth, unknown]> }[keyof T]
					: never;

/**
 * Dotted `module.function` paths of every public function whose return leaks.
 * Matching the reference's `_visibility` / `_returnType` members directly is
 * much cheaper than inferring against `FunctionReference<…>` for every node.
 */
type LeakingPublicFunctions<Node, Prefix extends string = ''> = {
	[K in keyof Node & string]: IsAny<Node[K]> extends true
		? never
		: Node[K] extends { _visibility: 'public'; _returnType: infer Returns }
			? true extends Leaks<Returns>
				? `${Prefix}${K}`
				: never
			: LeakingPublicFunctions<Node[K], `${Prefix}${K}.`>;
}[keyof Node & string];

/** Namespaces or functions the gate cannot inspect because they are `any`. */
type UninspectableNodes<Node, Prefix extends string = ''> = {
	[K in keyof Node & string]: IsAny<Node[K]> extends true
		? `${Prefix}${K}`
		: Node[K] extends { _visibility: 'public'; _returnType: infer Returns }
			? IsAny<Returns> extends true
				? `${Prefix}${K}`
				: never
			: UninspectableNodes<Node[K], `${Prefix}${K}.`>;
}[keyof Node & string];

type Leaking = LeakingPublicFunctions<typeof api>;

describe('public return-type redaction gate', () => {
	it('no public function returns a capability field', () => {
		// With no offender the declared type is `true`; otherwise it is the union
		// of the offending paths. The compiler may print part of that union still
		// folded (`LeakingPublicFunctions<{ … }, "inbox.">`); the prefix names the
		// directory, and a temporary `const x: LeakingPublicFunctions<(typeof
		// api)['inbox']['queries'], ''> = true` narrows it to the function. Fix
		// the handler (redact or project the row); do not widen its return to
		// `any` to get past this.
		const unreviewed: [Exclude<Leaking, ReviewedExceptions>] extends [never]
			? true
			: Exclude<Leaking, ReviewedExceptions> = true;
		// A listed exception that no longer leaks: delete its entry.
		const stale: [Exclude<ReviewedExceptions, Leaking>] extends [never]
			? true
			: Exclude<ReviewedExceptions, Leaking> = true;
		expect(unreviewed && stale).toBe(true);
	});

	it('can inspect every public function', () => {
		// An `any` node would pass the gate unseen. The usual cause is a stale
		// `_generated/api.d.ts` import of a deleted module: `skipLibCheck` hides
		// the broken import and the whole directory namespace degrades to `any`.
		// Worse, such a node can collapse the entire walk to `any`, which every
		// assignment above would accept — so the walk results themselves must
		// not be `any` either.
		expectTypeOf<Leaking>().not.toBeAny();
		expectTypeOf<UninspectableNodes<typeof api>>().not.toBeAny();
		const uninspectable: [UninspectableNodes<typeof api>] extends [never]
			? true
			: UninspectableNodes<typeof api> = true;
		expect(uninspectable).toBe(true);
	});

	// Guards the guard: if an edit to the predicate stops seeing a raw row, these
	// flip and typecheck fails even while every real endpoint is clean.
	it('flags raw token-bearing rows and joins, and passes redacted shapes', () => {
		expectTypeOf<true extends Leaks<Doc<'contacts'>> ? 1 : 0>().toEqualTypeOf<1>();
		expectTypeOf<
			true extends Leaks<Array<{ direction: 'outgoing'; relatedContact: Doc<'contacts'> | null }>>
				? 1
				: 0
		>().toEqualTypeOf<1>();
		expectTypeOf<
			true extends Leaks<{ page: Array<Doc<'shareLinks'>>; isDone: boolean }> ? 1 : 0
		>().toEqualTypeOf<1>();
		expectTypeOf<true extends Leaks<Doc<'webhooks'> | null> ? 1 : 0>().toEqualTypeOf<1>();
		expectTypeOf<true extends Leaks<Record<string, Doc<'apiKeys'>>> ? 1 : 0>().toEqualTypeOf<1>();

		expectTypeOf<true extends Leaks<PublicContact[]> ? 1 : 0>().toEqualTypeOf<0>();
		expectTypeOf<
			true extends Leaks<Omit<Doc<'webhooks'>, 'secret'> | null> ? 1 : 0
		>().toEqualTypeOf<0>();
		// A generic `token` / `secret` word on a non-row shape is not a leak.
		expectTypeOf<true extends Leaks<{ token: string; url: string }> ? 1 : 0>().toEqualTypeOf<0>();
	});
});
