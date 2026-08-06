/**
 * The SYSTEM/AUTH mail extras seam — the vocabulary half (the seams plan's P0.4).
 *
 * `systemMail.ts` is the single transport for password resets, invitations,
 * double opt-in and email-change mail. It used to decide the per-send knobs
 * itself: an `if (provider === 'mta')` arm building the MTA's system-intake
 * payload inline, and a `provider === 'resend' && key` ternary for the dedup
 * header — the same `providerKind === 'mta' ? … : 'resend' ? …` shape the seams
 * plan's P0.1 removed from the governed boundary, one file over, with the same
 * cost: every new kind had to edit the send path to be allowed any knob at all.
 *
 * A SEPARATE FILE, not two more declarations in `./types.ts`, because that file
 * sits within a few dozen lines of the ~500 LOC ratchet
 * (`scripts/check-file-size.sh`) — the same reason P0.1's declaration vocabulary
 * became `./catalogTypes.ts` (and, in P1.1, `@owlat/shared`). The mix-in is parameterized by the EXTRAS type
 * rather than by the kind so that nothing here has to import `ExtrasFor`, which
 * keeps the dependency one-directional: `./types.ts` reads this, never the
 * reverse.
 */

/**
 * Everything the system/auth mail path knows about one send.
 *
 * Deliberately NOT `DispatchExtrasInput`: that intake is ungoverned by
 * construction — no durable Send row, so no work-attempt identity, no re-entry
 * snapshot, no routing lease and no measurement cell — and the governed input's
 * required fields have no honest value there. Manufacturing them would put fake
 * governance identities on the one path that must never be held up by
 * governance.
 *
 * What the two inputs share is the only fact providers actually branch on: a
 * stable idempotency key. Here it is the CALLER's (an alert that must not
 * re-mail when its caller retries), and absent when the caller had none.
 */
export interface SystemMailExtrasInput {
	readonly idempotencyKey?: string | undefined;
}

/**
 * The optional system-mail extras wire, mixed into `SendProviderModule`.
 *
 * ABSENT MEANS "no per-send knobs on this path", which is the honest answer for
 * SES, a bring-your-own SMTP relay and Mandrill: the governed boundary is where
 * their knobs live, and system mail has no route, no cell and no lease to give
 * them. The boundary then passes the empty extras it has always passed.
 *
 * A kind whose catalog entry declares `deduplicatesOnIdempotencyKey: true` MUST
 * implement this and carry the key through in whatever form it dedups on — the
 * declaration is what tells `systemMailRetryDisposition` an ambiguous send may
 * be repeated, and a repeat that arrives without the key is simply a second mail
 * to a real person. Pinned in both directions, per core kind, by
 * `./__tests__/systemMailExtras.test.ts`.
 *
 * Pure and synchronous by contract, exactly like `buildDispatchExtras`: no ctx,
 * no env, no I/O. Every fact a provider may need is on the input.
 */
export interface SystemMailExtrasCapableModule<E> {
	buildSystemMailExtras?(input: SystemMailExtrasInput): E | undefined;
}
