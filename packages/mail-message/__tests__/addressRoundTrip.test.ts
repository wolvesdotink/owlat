/**
 * Unification decision U5 — ONE address model.
 *
 * The compose side's {@link encodeAddressHeader} and the parse side's
 * {@link parseAddressObject} sit on opposite ends of the same wire, so the
 * structured address model must survive a full round-trip: a display-name /
 * addr-spec pair encoded into a header value must re-parse back to the same
 * `{ name, address }` (RFC 2047 encoding of a non-ASCII phrase and quoting of a
 * special-character phrase are transparent to the recovered structure), and the
 * canonical `AddressObject.text` reconstruction must itself re-parse to the same
 * value (idempotence). This test pins that contract over a shared fixture set so
 * a future change to either formatter that breaks the pairing fails loudly.
 */

import { describe, it, expect } from 'vitest';
import { encodeAddressHeader, parseAddressObject } from '../src/index';

interface Mailbox {
	name: string;
	address: string;
}

interface RoundTripCase {
	label: string;
	/** Inputs handed to `encodeAddressHeader` (bare addr-spec or `name-addr`). */
	input: string[];
	/** The structured mailboxes we expect to recover after encode -> parse. */
	expected: Mailbox[];
}

const CASES: RoundTripCase[] = [
	{
		label: 'bare addr-spec, no display name',
		input: ['bob@example.com'],
		expected: [{ name: '', address: 'bob@example.com' }],
	},
	{
		label: 'ASCII display name',
		input: ['Alice <alice@example.com>'],
		expected: [{ name: 'Alice', address: 'alice@example.com' }],
	},
	{
		label: 'display name with a comma (needs quoting)',
		input: ['"Doe, John" <john@example.com>'],
		expected: [{ name: 'Doe, John', address: 'john@example.com' }],
	},
	{
		label: 'non-ASCII display name (RFC 2047 round-trip)',
		input: ['Jürgen Müller <jm@example.com>'],
		expected: [{ name: 'Jürgen Müller', address: 'jm@example.com' }],
	},
	{
		label: 'multiple mailboxes in one header',
		input: ['Alice <alice@example.com>', 'bob@example.com'],
		expected: [
			{ name: 'Alice', address: 'alice@example.com' },
			{ name: '', address: 'bob@example.com' },
		],
	},
];

function mailboxes(header: string): Mailbox[] {
	return parseAddressObject(header).value.map((entry) => ({
		name: entry.name,
		address: entry.address,
	}));
}

describe('address model round-trip (U5)', () => {
	for (const testCase of CASES) {
		it(`recovers the structured mailboxes for ${testCase.label}`, () => {
			const header = encodeAddressHeader(testCase.input);
			expect(mailboxes(header)).toEqual(testCase.expected);
		});

		it(`re-parses the canonical text idempotently for ${testCase.label}`, () => {
			const header = encodeAddressHeader(testCase.input);
			const canonical = parseAddressObject(header).text;
			// The canonical reconstruction must itself round-trip to the same value.
			expect(mailboxes(canonical)).toEqual(testCase.expected);
		});
	}
});
