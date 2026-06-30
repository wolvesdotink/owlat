/**
 * Per-literal **Contact activity (module)** display-half contract.
 *
 * Each module under `composables/contactActivities/<literal>/index.ts`
 * exports one of these — keyed by literal, dispatched by the typed
 * `ACTIVITY_EDITOR_MODULES` map in `./index.ts`. Carries the
 * timeline-UI rendering metadata: icon, label, color, plus a per-literal
 * `formatDescription(metadata)` formatter.
 *
 * The writer half lives at
 * `apps/api/convex/contactActivities/<literal>/index.ts`.
 */

import type { ContactActivityType } from '../../../../api/convex/contactActivities/catalog';
import type { MetadataFor } from '../../../../api/convex/contactActivities/writer';

export type { ContactActivityType, MetadataFor };

export interface ContactActivityDisplayConfig {
	readonly icon: string;
	readonly label: string;
	readonly color: string;
}

export interface ContactActivityEditorModule<L extends ContactActivityType> {
	readonly literal: L;
	readonly displayConfig: ContactActivityDisplayConfig;
	formatDescription(metadata: MetadataFor<L> | undefined): string;
}

export type ContactActivityEditorModuleMap = {
	[L in ContactActivityType]: ContactActivityEditorModule<L>;
};
