/**
 * Per-literal **Contact activity (module)** display-half contract.
 *
 * Each module under `composables/contactActivities/<literal>/index.ts`
 * exports one of these — keyed by literal, dispatched by the typed
 * `ACTIVITY_EDITOR_MODULES` map in `./index.ts`. Carries the
 * timeline-UI rendering metadata: icon, label, color, plus a per-literal
 * `formatDescription(metadata)` formatter.
 *
 * These are module-scope definitions, so they never call `useI18n`: `label`
 * holds a catalog KEY and `formatDescription` returns either a key or a
 * `{ key, params }` pair. The component that renders a module resolves them
 * (`t(label)`, `t(d.key, d.params)`) at render time, in the active locale.
 *
 * The writer half lives at
 * `apps/api/convex/contactActivities/<literal>/index.ts`.
 */

import type { ContactActivityType } from '../../../../api/convex/contactActivities/catalog';
import type { MetadataFor } from '../../../../api/convex/contactActivities/writer';

export type { ContactActivityType, MetadataFor };

export interface ContactActivityDisplayConfig {
	readonly icon: string;
	/** Catalog key for the timeline label — resolved with `t()` at render time. */
	readonly label: string;
	readonly color: string;
}

/**
 * A description a module hands the timeline: a bare catalog key, or a key plus
 * the values its message interpolates.
 */
export type ContactActivityDescription =
	| string
	| { readonly key: string; readonly params?: Record<string, string | number | undefined> };

export interface ContactActivityEditorModule<L extends ContactActivityType> {
	readonly literal: L;
	readonly displayConfig: ContactActivityDisplayConfig;
	formatDescription(metadata: MetadataFor<L> | undefined): ContactActivityDescription;
}

export type ContactActivityEditorModuleMap = {
	[L in ContactActivityType]: ContactActivityEditorModule<L>;
};
