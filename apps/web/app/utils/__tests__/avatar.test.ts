import { describe, expect, it } from 'vitest';
import {
	AVATAR_BG_CLASSES,
	AVATAR_COLOR_STYLES,
	AVATAR_COLOR_TOKENS,
	AVATAR_SIZE_CLASSES,
	avatarInitials,
	initialsAndColorForAddress,
} from '../avatar';

describe('avatarInitials', () => {
	it('takes the first two characters of the name, upper-cased', () => {
		expect(avatarInitials('Marcel', 'marcel@example.com')).toBe('MA');
	});

	it('falls back to email when no name is present', () => {
		expect(avatarInitials(null, 'zoe@example.com')).toBe('ZO');
		expect(avatarInitials(undefined, 'zoe@example.com')).toBe('ZO');
	});

	it('falls back to "?" when neither name nor email is present', () => {
		expect(avatarInitials()).toBe('?');
		expect(avatarInitials(null, null)).toBe('?');
	});

	it('always upper-cases and slices to two characters', () => {
		expect(avatarInitials('ab')).toBe('AB');
		expect(avatarInitials('a')).toBe('A');
		expect(avatarInitials('abcdef')).toBe('AB');
	});
});

describe('AVATAR_SIZE_CLASSES', () => {
	it('maps each size preset to a diameter class', () => {
		expect(AVATAR_SIZE_CLASSES.xs).toContain('w-5');
		expect(AVATAR_SIZE_CLASSES.sm).toContain('w-6');
		expect(AVATAR_SIZE_CLASSES.md).toContain('w-7');
		expect(AVATAR_SIZE_CLASSES.lg).toContain('w-9');
	});
});

describe('AVATAR_BG_CLASSES', () => {
	it('maps background variants to their surface classes', () => {
		expect(AVATAR_BG_CLASSES.surface).toBe('bg-bg-surface');
		expect(AVATAR_BG_CLASSES.elevated).toBe('bg-bg-elevated');
	});
});

describe('initialsAndColorForAddress', () => {
	it('takes the first letters of the first two name words', () => {
		expect(initialsAndColorForAddress('Ada Bell').initials).toBe('AB');
		expect(initialsAndColorForAddress('ada lovelace king').initials).toBe('AL');
	});

	it('derives initials from the local part of a bare email', () => {
		expect(initialsAndColorForAddress('jane.doe@example.com').initials).toBe('JD');
		expect(initialsAndColorForAddress('first-last@example.com').initials).toBe('FL');
		expect(initialsAndColorForAddress('zoe@example.com').initials).toBe('ZO');
	});

	it('falls back to two characters for single-word names', () => {
		expect(initialsAndColorForAddress('Marcel').initials).toBe('MA');
		expect(initialsAndColorForAddress('a').initials).toBe('A');
	});

	it('returns "?" for blank input', () => {
		expect(initialsAndColorForAddress('  ').initials).toBe('?');
	});

	it('is deterministic: same input always yields the same color', () => {
		const a = initialsAndColorForAddress('jane.doe@example.com');
		const b = initialsAndColorForAddress('jane.doe@example.com');
		expect(a.colorToken).toBe(b.colorToken);
	});

	it('keys the color on colorKey so display-name changes keep the color stable', () => {
		const asName = initialsAndColorForAddress('Jane Doe', { colorKey: 'jane@example.com' });
		const asOtherName = initialsAndColorForAddress('Jane D.', { colorKey: 'jane@example.com' });
		const asEmail = initialsAndColorForAddress('jane@example.com');
		expect(asName.colorToken).toBe(asOtherName.colorToken);
		expect(asName.colorToken).toBe(asEmail.colorToken);
	});

	it('normalizes the hash key (case + whitespace)', () => {
		expect(initialsAndColorForAddress('Jane@Example.com ').colorToken).toBe(
			initialsAndColorForAddress('jane@example.com').colorToken
		);
	});

	it('spreads distinct inputs across the palette', () => {
		const tokens = new Set(
			Array.from({ length: 40 }, (_, i) =>
				initialsAndColorForAddress(`user${i}@example${i % 7}.com`).colorToken
			)
		);
		// 40 distinct addresses over a 10-token palette must hit most tokens.
		expect(tokens.size).toBeGreaterThanOrEqual(7);
	});

	it('always returns a token present in the palette', () => {
		for (const input of ['a@b.c', 'Some Body', 'weird+tag@sub.example.co.uk']) {
			const { colorToken } = initialsAndColorForAddress(input);
			expect(AVATAR_COLOR_TOKENS).toContain(colorToken);
			expect(AVATAR_COLOR_STYLES[colorToken]).toBeDefined();
		}
	});
});

describe('AVATAR_COLOR_STYLES', () => {
	// WCAG relative luminance + contrast ratio, per
	// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
	function luminance(hex: string): number {
		const c = hex.replace('#', '');
		const channel = (i: number) => {
			const v = parseInt(c.slice(i, i + 2), 16) / 255;
			return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
	}
	function contrast(a: string, b: string): number {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
		return (hi + 0.05) / (lo + 0.05);
	}

	it('every palette token has WCAG-AA text contrast (>= 4.5:1)', () => {
		for (const token of AVATAR_COLOR_TOKENS) {
			const { background, color } = AVATAR_COLOR_STYLES[token];
			expect(contrast(background, color), `token ${token}`).toBeGreaterThanOrEqual(4.5);
		}
	});
});
