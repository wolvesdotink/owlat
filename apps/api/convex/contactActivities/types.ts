/**
 * Per-literal **Contact activity (module)** writer-half contract.
 *
 * Each module under `contactActivities/<literal>/index.ts` exports one of
 * these — keyed by literal, dispatched by the typed `ACTIVITY_MODULES`
 * map in `./writer.ts`. The `metadataSchema` is the compile-time contract
 * for the per-literal metadata blob; `Infer<typeof schema>` produces the
 * `MetadataFor<L>` type that the writer's args use to constrain callers.
 *
 * The display half lives at
 * `apps/web/app/composables/contactActivities/<literal>/index.ts`.
 */

import type { Validator } from 'convex/values';

export interface ContactActivityModule<L extends string, TMetadata> {
	readonly literal: L;
	readonly metadataSchema: Validator<TMetadata, 'required', string>;
}
