import { describe, expect, it } from 'vitest';
import { AVATAR_BG_CLASSES, AVATAR_SIZE_CLASSES, avatarInitials } from '../avatar';

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
