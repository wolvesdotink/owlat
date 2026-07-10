/**
 * Per-workspace identity accent → CSS custom property.
 *
 * The desktop chrome (identity frame, titlebar wash, sidebar tint, active-nav
 * highlight) is painted purely in CSS (assets/css/desktop.css) from a single
 * custom property, `--ws-accent`, using color-mix() against the Fluid
 * Functionalism surface tokens — so light and dark themes both derive correctly
 * with no extra JS. This module owns setting that property on <html> for the
 * active workspace. Content surfaces (cards / reader / composer) get no tint.
 */

import type { WorkspaceAccent } from '~/lib/desktop/workspaceTypes';

/** The CSS custom property the desktop chrome derives all accent tints from. */
export const WS_ACCENT_VAR = '--ws-accent';

/** Set (or clear, when null) the active workspace accent on the given element. */
export function applyWorkspaceAccent(el: HTMLElement, accent: WorkspaceAccent | null): void {
	if (accent) el.style.setProperty(WS_ACCENT_VAR, accent);
	else el.style.removeProperty(WS_ACCENT_VAR);
}

/**
 * Derive the accent tint color-mix() expressions the desktop chrome paints from
 * a given accent. Kept as a pure function purely so the recipe (which surface,
 * which percentage) is unit-testable and documented in one place; the live
 * paint is done by the mirrored CSS in assets/css/desktop.css. Both themes are
 * covered automatically because each mix targets a theme-aware FF token.
 */
export function workspaceAccentTints(accent: string): {
	frame: string;
	titlebar: string;
	sidebar: string;
	activeNav: string;
} {
	return {
		// Inset identity ring hugging the vibrant window edge.
		frame: `color-mix(in srgb, ${accent} 55%, transparent)`,
		// Titlebar wash: 7% accent over the elevated surface.
		titlebar: `color-mix(in srgb, ${accent} 7%, var(--color-bg-elevated))`,
		// Sidebar tint: 5% accent.
		sidebar: `color-mix(in srgb, ${accent} 5%, var(--color-bg-elevated))`,
		// Active nav item: 14% accent.
		activeNav: `color-mix(in srgb, ${accent} 14%, transparent)`,
	};
}
