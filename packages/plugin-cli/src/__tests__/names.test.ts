import { describe, expect, it } from 'vitest';
import { toCamelCase } from '../names';

/**
 * The identifier derivation every scaffold template rests on.
 *
 * It lives beside its subject rather than in `scaffold.test.ts` (where it was
 * written, before `names.ts` was extracted to break a module cycle): the emitted
 * manifest exports `<camel>Plugin` and the emitted `index.ts` re-exports that
 * name, so a change here is a change to whether generated packages compile, and
 * someone rewriting `names.ts` has to be able to find the suite that pins it.
 */
describe('toCamelCase', () => {
	it('converts a kebab-case id to lowerCamelCase', () => {
		expect(toCamelCase('deliverability-lab')).toBe('deliverabilityLab');
		expect(toCamelCase('a-b-c')).toBe('aBC');
		expect(toCamelCase('single')).toBe('single');
	});

	// A plugin id is `[a-z][a-z0-9]*(-[a-z0-9]+)*`, so a segment may begin with a
	// digit — which has no upper case. The result must still be a legal identifier
	// rather than one that silently lost its separator into a syntax error.
	it('leaves a digit-led segment alone rather than dropping the separator', () => {
		expect(toCamelCase('acme2-relay3')).toBe('acme2Relay3');
		expect(toCamelCase('acme-2relay')).toBe('acme2relay');
	});
});
