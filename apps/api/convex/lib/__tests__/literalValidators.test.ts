/**
 * One spelling per vocabulary: the stored union, the argument unions and the
 * TypeScript type all derive from one list, so a new member cannot reach one of
 * them and miss the others.
 *
 * The block-list reason is the case this exists for: `unengaged` was added by
 * hand to the schema, the list filter, the suppression mirror's type and both
 * counters, and the shared validator named for the table was left behind.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_LOCALES } from '@owlat/shared/appLocales';
import { deliveryTables } from '../../schema/delivery';
import { authTables } from '../../schema/auth';
import { appLocaleValidator } from '../appLocales';
import * as literalValidators from '../literalValidators';
import {
	BLOCK_REASONS,
	blockedEmailReasonValidator,
	manualOrEventBlockReasonValidator,
} from '../literalValidators';

const membersOf = (validator: { members: readonly { value: unknown }[] }) =>
	validator.members.map((member) => member.value);

describe('block-list reasons', () => {
	it('derives the stored-reason validator from BLOCK_REASONS', () => {
		expect(membersOf(blockedEmailReasonValidator)).toEqual([...BLOCK_REASONS]);
	});

	it('is the validator the blockedEmails.reason column uses', () => {
		expect(deliveryTables.blockedEmails.validator.fields.reason).toBe(blockedEmailReasonValidator);
	});

	it('keeps the write-arg set narrower: no sunset reason from a caller', () => {
		const writable = membersOf(manualOrEventBlockReasonValidator);
		expect(writable).not.toContain('unengaged');
		for (const reason of writable) expect(BLOCK_REASONS).toContain(reason);
	});
});

describe('interface locales', () => {
	it('derives the profile-locale validator from the shared list', () => {
		expect(membersOf(appLocaleValidator)).toEqual([...APP_LOCALES]);
	});

	it('is the validator userProfiles.locale stores through', () => {
		const locale = authTables.userProfiles.validator.fields.locale;
		expect(locale.isOptional).toBe('optional');
		expect(membersOf(locale as unknown as typeof appLocaleValidator)).toEqual([...APP_LOCALES]);
	});
});

describe('CONVENTIONS.md', () => {
	it('names only validators lib/literalValidators.ts actually exports', () => {
		const conventions = readFileSync(new URL('../../CONVENTIONS.md', import.meta.url), 'utf8');
		const bullet = conventions.match(/- `lib\/literalValidators\.ts`:[^]*?\.\.\.\)/)?.[0];
		expect(bullet).toBeDefined();
		const named = [...bullet!.matchAll(/`(\w+Validator)`/g)].map((match) => match[1]);
		expect(named.length).toBeGreaterThan(0);
		for (const name of named) expect(literalValidators).toHaveProperty(name as string);
	});
});
