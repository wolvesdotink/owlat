import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_ACCENT, WORKSPACE_ACCENTS, pickAccentColor } from '../workspaceTypes';
import { WS_ACCENT_VAR, applyWorkspaceAccent, workspaceAccentTints } from '../workspaceAccent';

describe('pickAccentColor (round-robin default assignment)', () => {
	it('assigns each curated accent in order for the first six workspaces', () => {
		const assigned = Array.from({ length: WORKSPACE_ACCENTS.length }, (_, i) => pickAccentColor(i));
		expect(assigned).toEqual([...WORKSPACE_ACCENTS]);
	});

	it('wraps around after the palette is exhausted', () => {
		expect(pickAccentColor(WORKSPACE_ACCENTS.length)).toBe(WORKSPACE_ACCENTS[0]);
		expect(pickAccentColor(WORKSPACE_ACCENTS.length + 1)).toBe(WORKSPACE_ACCENTS[1]);
		expect(pickAccentColor(13)).toBe(WORKSPACE_ACCENTS[1]); // 13 % 6 === 1
	});

	it('handles negative and fractional indices defensively', () => {
		expect(pickAccentColor(-1)).toBe(WORKSPACE_ACCENTS[WORKSPACE_ACCENTS.length - 1]);
		expect(pickAccentColor(2.9)).toBe(WORKSPACE_ACCENTS[2]);
	});

	it('exposes terracotta (the brand hue) as the default fallback', () => {
		expect(DEFAULT_WORKSPACE_ACCENT).toBe('#c4785a');
	});
});

describe('applyWorkspaceAccent', () => {
	it('sets the --ws-accent custom property when given a colour', () => {
		const el = document.createElement('html');
		applyWorkspaceAccent(el, '#7a8c5a');
		expect(el.style.getPropertyValue(WS_ACCENT_VAR)).toBe('#7a8c5a');
	});

	it('clears the property when given null', () => {
		const el = document.createElement('html');
		applyWorkspaceAccent(el, '#7a8c5a');
		applyWorkspaceAccent(el, null);
		expect(el.style.getPropertyValue(WS_ACCENT_VAR)).toBe('');
	});
});

describe('workspaceAccentTints (theme-agnostic color-mix derivation)', () => {
	// Each tint mixes the accent against a theme-aware FF token, so a single
	// recipe resolves correctly in BOTH light and dark — the snapshot pins the
	// percentages and token targets that the CSS in desktop.css mirrors.
	it('derives frame / titlebar / sidebar / active-nav mixes from one accent', () => {
		expect(workspaceAccentTints('#c4785a')).toEqual({
			frame: 'color-mix(in srgb, #c4785a 55%, transparent)',
			titlebar: 'color-mix(in srgb, #c4785a 7%, var(--color-bg-elevated))',
			sidebar: 'color-mix(in srgb, #c4785a 5%, var(--color-bg-elevated))',
			activeNav: 'color-mix(in srgb, #c4785a 14%, transparent)',
		});
	});

	it('is a pure substitution of the accent value', () => {
		expect(workspaceAccentTints('#5a7a9b').titlebar).toBe(
			'color-mix(in srgb, #5a7a9b 7%, var(--color-bg-elevated))'
		);
	});
});
