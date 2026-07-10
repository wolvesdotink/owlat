/**
 * Perceived-instant workspace switch choreography (piece d4).
 *
 * Switching workspaces reloads the whole webview (useDesktopWorkspaces.switchTo
 * → location.assign) so the auth + Convex singletons re-seed cleanly. A cold
 * reload can take a beat, which reads as a dead click. To make the switch FEEL
 * <=300ms we choreograph the paint order around that unavoidable reload:
 *
 *   1. BEFORE the reload we repaint the target workspace's identity accent and
 *      drop a full-window skeleton (titlebar + sidebar silhouette, tinted in the
 *      new accent) over the current page, so the eye sees the destination's
 *      colour instantly.
 *   2. A sessionStorage flag carries the accent + label across the reload. The
 *      desktop boot plugin reads it on the fresh document and re-paints the same
 *      skeleton FIRST — before Nuxt mounts — then crossfades it away once the app
 *      has painted its first real frame.
 *
 * No auth/Convex/network changes: this is purely paint-order choreography. A TTL
 * on the flag guards against a stale skeleton if the reload never lands (e.g. a
 * failed navigation) — a stale flag is discarded rather than shown.
 */

import { workspaceAccentTints } from '~/lib/desktop/workspaceAccent';

/** sessionStorage key carrying the pending-switch skeleton descriptor. */
export const SWITCH_FLAG_KEY = 'owlat:ws-switch';

/**
 * The skeleton crossfade duration, mirroring the `--motion-slow` token (240ms).
 * The live transition still reads the token via CSS var; this constant is the
 * documented fallback used when the resolved duration can't be measured, so both
 * derive from the same number and a token change can't silently truncate the
 * crossfade or leave the fallback timer lagging.
 */
export const CROSSFADE_SLOW_MS = 240;

/** A 6-digit hex colour (`#rrggbb`) — the only accent shape the skeleton paints. */
const HEX6 = /^#[0-9a-f]{6}$/i;

/**
 * How long a switch flag stays valid. If the fresh document reads a flag older
 * than this, the reload evidently stalled/failed and we discard it rather than
 * flash a skeleton for a switch that never happened. Also the hard cap on how
 * long the post-reload skeleton may linger before it force-removes itself.
 */
export const SWITCH_FLAG_TTL_MS = 4000;

/** DOM marker so the skeleton is only ever inserted / removed once. */
const SKELETON_ATTR = 'data-owlat-switch-skeleton';

/** Descriptor persisted across the reload so the new document can re-paint. */
export interface WorkspaceSwitchFlag {
	/** Target workspace identity accent (hex) — paints the skeleton chrome. */
	accent: string;
	/** Target workspace label — shown in the skeleton titlebar chip. */
	label: string;
	/** Epoch ms the switch began (for the TTL staleness guard). */
	at: number;
}

function isSwitchFlag(value: unknown): value is WorkspaceSwitchFlag {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v['accent'] === 'string' &&
		// Validate the accent shape: it is interpolated into color-mix()/box-shadow
		// style strings, so a corrupted flag from sessionStorage must not render a
		// broken skeleton. (Style assignment can't escape the property, so this is
		// cheap hardening rather than an injection fix.)
		HEX6.test(v['accent']) &&
		typeof v['label'] === 'string' &&
		typeof v['at'] === 'number'
	);
}

/** Persist the pending-switch descriptor. Swallows quota/serialization errors. */
export function writeSwitchFlag(storage: Storage, flag: WorkspaceSwitchFlag): void {
	try {
		storage.setItem(SWITCH_FLAG_KEY, JSON.stringify(flag));
	} catch {
		// sessionStorage unavailable / full — the switch still works, just without
		// the cross-reload skeleton handoff.
	}
}

/**
 * Read + validate the pending-switch descriptor. Returns null when absent,
 * malformed, or stale (older than {@link SWITCH_FLAG_TTL_MS} at `now`) — the
 * staleness check is the guard against painting a skeleton for a switch whose
 * reload never landed.
 */
export function readSwitchFlag(storage: Storage, now: number): WorkspaceSwitchFlag | null {
	let raw: string | null;
	try {
		raw = storage.getItem(SWITCH_FLAG_KEY);
	} catch {
		return null;
	}
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isSwitchFlag(parsed)) return null;
	if (now - parsed.at > SWITCH_FLAG_TTL_MS || parsed.at > now) return null;
	return parsed;
}

/** Clear the pending-switch descriptor (best-effort). */
export function clearSwitchFlag(storage: Storage): void {
	try {
		storage.removeItem(SWITCH_FLAG_KEY);
	} catch {
		// ignore
	}
}

// ── skeleton DOM ────────────────────────────────────────────────────────────

function styled(tag: string, styles: Partial<CSSStyleDeclaration>): HTMLElement {
	const el = document.createElement(tag);
	Object.assign(el.style, styles);
	return el;
}

/**
 * Build (but do not attach) the full-window switch skeleton for a given accent:
 * a bg-base sheet with a titlebar strip + sidebar silhouette washed in the
 * accent, mirroring the live desktop chrome so the reload replaces like with
 * like. Text is set via textContent (never innerHTML) so a workspace label can
 * never inject markup.
 */
function buildSkeleton(accent: string, label: string): HTMLElement {
	// Derive the titlebar / sidebar / frame tints from the same SSOT the live
	// chrome uses (workspaceAccentTints), so the skeleton can never drift from it.
	const tints = workspaceAccentTints(accent);
	const shimmer = 'color-mix(in srgb, var(--color-text-tertiary) 22%, transparent)';

	const root = styled('div', {
		position: 'fixed',
		inset: '0',
		zIndex: '2147483000',
		display: 'flex',
		flexDirection: 'column',
		backgroundColor: 'var(--color-bg-base)',
		opacity: '1',
	});
	root.setAttribute(SKELETON_ATTR, '');
	root.setAttribute('aria-hidden', 'true');
	// Identity frame ring, matching the live body::after accent ring — width and
	// radius read from the same desktop.css custom properties (fallbacks mirror
	// their defaults) so the ring geometry can't drift from the live chrome.
	root.style.boxShadow = `inset 0 0 0 var(--ws-frame-width, 5px) ${tints.frame}`;
	root.style.borderRadius = 'var(--ws-frame-radius, 10px)';

	// Titlebar strip with the destination label chip.
	const titlebar = styled('div', {
		height: '38px',
		flex: '0 0 auto',
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		paddingLeft: '88px',
		paddingRight: '12px',
		backgroundColor: tints.titlebar,
		borderBottom: '1px solid var(--color-border-subtle)',
	});
	const dot = styled('span', {
		width: '10px',
		height: '10px',
		borderRadius: '9999px',
		backgroundColor: accent,
		flex: '0 0 auto',
	});
	const chip = styled('span', {
		fontSize: '13px',
		lineHeight: '1',
		color: 'var(--color-text-secondary)',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	});
	chip.textContent = label;
	titlebar.append(dot, chip);

	// Body row: sidebar silhouette + empty content.
	const body = styled('div', { flex: '1 1 auto', display: 'flex', minHeight: '0' });
	const sidebar = styled('div', {
		width: '240px',
		flex: '0 0 auto',
		backgroundColor: tints.sidebar,
		borderRight: '1px solid var(--color-border-subtle)',
		padding: '16px 12px',
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
	});
	for (const w of ['70%', '55%', '62%', '48%', '58%']) {
		sidebar.append(
			styled('div', {
				height: '12px',
				width: w,
				borderRadius: '6px',
				backgroundColor: shimmer,
			})
		);
	}
	body.append(sidebar, styled('div', { flex: '1 1 auto' }));

	root.append(titlebar, body);
	return root;
}

/** Whether the viewer has asked to reduce motion (crossfades collapse to cuts). */
function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

/**
 * Paint the switch skeleton over the current document. Idempotent — a second
 * call while one is already mounted is a no-op and returns the existing node.
 */
export function showSwitchSkeleton(accent: string, label: string): HTMLElement {
	const existing = document.querySelector<HTMLElement>(`[${SKELETON_ATTR}]`);
	if (existing) return existing;
	const el = buildSkeleton(accent, label);
	document.body.appendChild(el);
	return el;
}

/**
 * Crossfade the skeleton away at --motion-slow, then remove it. Idempotent and
 * safe to call with a detached/already-removed node. Honors reduced motion by
 * cutting immediately.
 */
export function hideSwitchSkeleton(el?: HTMLElement | null): void {
	const node =
		el ??
		(typeof document !== 'undefined'
			? document.querySelector<HTMLElement>(`[${SKELETON_ATTR}]`)
			: null);
	if (!node || node.dataset['leaving'] === '1') return;
	node.dataset['leaving'] = '1';
	const finish = () => node.remove();
	if (prefersReducedMotion()) {
		finish();
		return;
	}
	node.style.transition = 'opacity var(--motion-slow) var(--ease-exit)';
	node.style.opacity = '0';
	node.addEventListener('transitionend', finish, { once: true });
	// Fallback if transitionend never fires (e.g. the element is display:none):
	// wait the real resolved --motion-slow duration (or the documented constant
	// when it can't be measured) plus a small buffer, so a token change can never
	// truncate the crossfade or leave this timer lagging behind it.
	window.setTimeout(finish, resolvedTransitionMs(node) + 20);
}

/**
 * Best-effort read of a node's resolved transition-duration in ms (first
 * component only). Falls back to {@link CROSSFADE_SLOW_MS} when the value is
 * missing / zero / unparseable (e.g. jsdom-style environments that don't resolve
 * CSS custom properties).
 */
function resolvedTransitionMs(node: HTMLElement): number {
	if (typeof getComputedStyle !== 'function') return CROSSFADE_SLOW_MS;
	const first = (getComputedStyle(node).transitionDuration || '').split(',')[0]?.trim() ?? '';
	let ms = 0;
	if (first.endsWith('ms')) ms = Number.parseFloat(first);
	else if (first.endsWith('s')) ms = Number.parseFloat(first) * 1000;
	return Number.isFinite(ms) && ms > 0 ? ms : CROSSFADE_SLOW_MS;
}
