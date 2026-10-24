/**
 * A validator built from a tuple accepts exactly the tuple's literals, so the
 * exported type and the validator cannot hold different vocabularies.
 */

import type { Infer } from 'convex/values';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	EXTERNAL_SYNC_MODES,
	SYSTEM_FOLDER_ROLES,
	externalSyncModeValidator,
	folderRoleValidator,
	type ExternalSyncMode,
	type FolderRole,
} from '../fields';
import { literalUnion } from '../literalUnion';

const memberValues = (validator: { members: readonly { value: unknown }[] }) =>
	validator.members.map((member) => member.value);

describe('literalUnion', () => {
	it('keeps the tuple order and infers the closed union', () => {
		const validator = literalUnion(['a', 'b', 3] as const);
		expect(memberValues(validator)).toEqual(['a', 'b', 3]);
		expectTypeOf<Infer<typeof validator>>().toEqualTypeOf<'a' | 'b' | 3>();
	});

	it('refuses an empty computed list', () => {
		expect(() => literalUnion(new Set<string>())).toThrow('at least one literal');
	});

	it.each([
		['folder roles', folderRoleValidator, SYSTEM_FOLDER_ROLES],
		['external sync modes', externalSyncModeValidator, EXTERNAL_SYNC_MODES],
	] as const)('derives the %s validator from its tuple', (_name, validator, tuple) => {
		expect(memberValues(validator)).toEqual([...tuple]);
	});

	it('gives the field validators their tuples’ types', () => {
		expectTypeOf<Infer<typeof folderRoleValidator>>().toEqualTypeOf<FolderRole>();
		expectTypeOf<Infer<typeof externalSyncModeValidator>>().toEqualTypeOf<ExternalSyncMode>();
	});
});
