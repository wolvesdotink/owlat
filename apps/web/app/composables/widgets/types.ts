import type { Component } from 'vue';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';

/**
 * Panel / widget contribution registry.
 *
 * This generalises the proven async-editor-component shape (see
 * `~/composables/automations/steps` — `{ kind, label, …, EditorComponent }`) so
 * the same host-mediated pattern serves *display* surfaces: dashboard cards and
 * thread-sidebar context panels. A `WidgetModule` is a single lazily-loaded UI
 * contribution addressed by a stable `kind`.
 *
 * A registry is composed once, deterministically, from core (built-in) modules
 * plus host-composed plugin contributions. Consumers render a module through
 * `WidgetHost`, which isolates it behind an error boundary so a broken plugin
 * panel can never take down the surrounding page.
 */

/**
 * Where a widget came from. `label`/`description` on a plugin-sourced widget
 * originate in an (untrusted) plugin manifest and must only ever be rendered as
 * text — never `v-html`.
 */
export type WidgetSource = 'core' | { readonly pluginId: string };

export interface WidgetModule {
	/** Stable identifier for the widget — the surface addresses widgets by this. */
	readonly kind: string;
	/**
	 * Human label. Optional for core dashboard cards, whose labels are sourced
	 * from the backend catalog; required in practice for plugin contributions so
	 * an editor can list them.
	 */
	readonly label?: string;
	readonly description?: string;
	readonly icon?: string;
	/**
	 * Optional feature flag gating the widget. When set and disabled, the widget
	 * resolves as `disabled` (feature-off) rather than rendering.
	 */
	readonly flag?: FeatureFlagKey;
	/** Provenance of the contribution. */
	readonly source: WidgetSource;
	/**
	 * The lazy async component (`defineAsyncComponent(() => import(...))`). The
	 * import is only evaluated when the widget is actually rendered.
	 */
	readonly component: Component;
}

/**
 * The outcome of resolving a `kind` against a registry with the current flag
 * state. `unknown` and `disabled` are distinct so a surface can render an
 * explicit "unknown widget" affordance while silently omitting a flagged-off one.
 */
export type WidgetResolution =
	| { readonly status: 'ok'; readonly module: WidgetModule }
	| { readonly status: 'disabled'; readonly module: WidgetModule }
	| { readonly status: 'unknown' };

/** An immutable, deterministically-ordered set of widget modules. */
export interface WidgetRegistry {
	has(kind: string): boolean;
	get(kind: string): WidgetModule | null;
	/** All modules in canonical order: core in declared order, then plugins. */
	list(): readonly WidgetModule[];
	/** The kinds of `list()`, in the same order. */
	kinds(): readonly string[];
}
