import { describe, it, expect } from 'vitest';
import {
	defaultPostboxNotifyAbout,
	resolvePostboxNotifyAbout,
} from '../postboxNotify';

describe('defaultPostboxNotifyAbout', () => {
	it("defaults to 'people-important' once smart categories are live", () => {
		expect(defaultPostboxNotifyAbout(true)).toBe('people-important');
	});
	it("defaults to 'everything' when categories are not live", () => {
		expect(defaultPostboxNotifyAbout(false)).toBe('everything');
	});
});

describe('resolvePostboxNotifyAbout', () => {
	it('passes through a valid stored value', () => {
		expect(resolvePostboxNotifyAbout('nothing', true)).toBe('nothing');
		expect(resolvePostboxNotifyAbout('everything', true)).toBe('everything');
		expect(resolvePostboxNotifyAbout('people-important', false)).toBe('people-important');
	});
	it('falls back to the category-aware default for undefined/unknown', () => {
		expect(resolvePostboxNotifyAbout(undefined, true)).toBe('people-important');
		expect(resolvePostboxNotifyAbout(null, false)).toBe('everything');
		expect(resolvePostboxNotifyAbout('garbage', true)).toBe('people-important');
	});
});
