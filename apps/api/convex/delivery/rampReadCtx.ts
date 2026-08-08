/**
 * THE RAMP'S READ HANDLE — one type, one name.
 *
 * READER-TYPED (ADR-0042). The ramp's observers only read, so they take the
 * narrowest handle that can express that: a `MutationCtx` would let a future
 * edit write from what is meant to be a pure observation, and it would keep the
 * dashboard query from reusing the very reader the controller decided on. The
 * two disagreeing about a number is the failure ADR-0042 is about.
 *
 * DECLARED ONCE. The presence reader and the promotion-evidence reader used to
 * declare the same `{ db: DatabaseReader }` under two names, which is one type
 * pretending to be two — and the moment they drift, the "same reader" property
 * above stops being enforceable by the compiler.
 */

import type { DatabaseReader } from '../_generated/server';

export interface RampReadCtx {
	readonly db: DatabaseReader;
}
