import { describe, it, expect } from 'vitest';
import { isContactScopeVisible } from '../contactScope';
import type { Id } from '../../_generated/dataModel';

const A = 'contact_A' as Id<'contacts'>;
const B = 'contact_B' as Id<'contacts'>;
const C = 'contact_C' as Id<'contacts'>;

describe('isContactScopeVisible — agent draft data-isolation rule', () => {
	describe('org-general rows (no contactIds) are always visible', () => {
		it('undefined contactIds is visible for a specific contact', () => {
			expect(isContactScopeVisible(undefined, A)).toBe(true);
		});
		it('empty contactIds is visible for a specific contact', () => {
			expect(isContactScopeVisible([], A)).toBe(true);
		});
		it('org-general row is visible under org-general-only', () => {
			expect(isContactScopeVisible(undefined, 'org-general-only')).toBe(true);
			expect(isContactScopeVisible([], 'org-general-only')).toBe(true);
		});
	});

	describe('specific-contact scope', () => {
		it('row linked to the scoped contact is visible', () => {
			expect(isContactScopeVisible([A], A)).toBe(true);
		});
		it('row linked to the scoped contact among others is visible', () => {
			expect(isContactScopeVisible([B, A, C], A)).toBe(true);
		});
		it("row linked ONLY to another contact is NOT visible (the core leak)", () => {
			expect(isContactScopeVisible([B], A)).toBe(false);
		});
		it('row linked to several OTHER contacts is NOT visible', () => {
			expect(isContactScopeVisible([B, C], A)).toBe(false);
		});
	});

	describe("'org-general-only' scope (inbound has no resolved contact — fail closed)", () => {
		it('contact-linked rows are NOT visible', () => {
			expect(isContactScopeVisible([A], 'org-general-only')).toBe(false);
			expect(isContactScopeVisible([A, B], 'org-general-only')).toBe(false);
		});
	});
});
