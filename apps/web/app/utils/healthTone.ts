/**
 * The single tone → token-class mapping for delivery/reputation health signals.
 *
 * The sidebar Delivery dot, the health page's verdict chip, and the domain
 * table's dots + chips all speak the same visual language: a semantic
 * success/warning/error (or neutral "no signal yet") tone rendered as either a
 * solid dot fill or a tinted chip. This is the one place that mapping lives, so
 * the three surfaces can never drift apart. Terracotta (brand) is deliberately
 * absent — it is reserved for actions and links, never health state.
 */

/** Canonical health tone. `neutral` = no signal yet (e.g. a domain with no activity). */
export type HealthTone = 'success' | 'warning' | 'error' | 'neutral';

/** The traffic-light level shared by the roll-up query and the verdict chip. */
export type HealthLevel = 'ok' | 'warn' | 'error';

/** Map the roll-up level to the canonical tone. */
export function levelTone(level: HealthLevel): HealthTone {
	if (level === 'error') return 'error';
	if (level === 'warn') return 'warning';
	return 'success';
}

/** Solid dot fill per tone (small indicator — allowed to use the brand-free fills). */
export const healthDotClass: Record<HealthTone, string> = {
	success: 'bg-success',
	warning: 'bg-warning',
	error: 'bg-error',
	neutral: 'bg-text-tertiary',
};

/** Tinted chip (background + text) per tone. */
export const healthChipClass: Record<HealthTone, string> = {
	success: 'bg-success/10 text-success',
	warning: 'bg-warning/10 text-warning',
	error: 'bg-error/10 text-error',
	neutral: 'bg-bg-surface text-text-secondary',
};

/** Bare text colour per tone (e.g. a standalone status glyph or label). */
export const healthTextClass: Record<HealthTone, string> = {
	success: 'text-success',
	warning: 'text-warning',
	error: 'text-error',
	neutral: 'text-text-tertiary',
};
