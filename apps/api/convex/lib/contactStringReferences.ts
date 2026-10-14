/**
 * The hand-kept half of the contact reference gates. A contact id belongs in a
 * `v.id('contacts')` field; the merge and erasure coverage gates
 * (`__tests__/contactMergeRelations.test.ts`, `contactErasureRelations.test.ts`)
 * find those by walking the schema, and find plain strings that hold contact
 * ids by their names (`contactId`, or `scopeId` beside `scopeType: 'contact'`;
 * the rule is in `__tests__/schemaReferences.ts`).
 *
 * No name rule sees an arbitrarily named string, or a plain-string record key,
 * that holds a contact id. Declare such a field below and the gates hold it to
 * the same standard as the rest: a merge routine or exclusion in
 * `lib/contactMutations.ts`, an erasure policy in `contacts/erasure/relations.ts`,
 * and a seeded row in the executable fixtures. A field the rule claims that is
 * not a contact id is listed in `NOT_CONTACT_STRING_REFERENCES` with a reason.
 * The gates check both lists against the schema, so neither can go stale.
 *
 * Keys are `table.field`, with `[]` for an array element, `{}` for a record
 * value and `{key}` for a record key.
 */

/** Plain-string contact ids the name rule cannot see, and why each is a string. */
export const DECLARED_CONTACT_STRING_REFERENCES: Readonly<Record<string, string>> = {};

/** Plain strings the name rule claims that do not hold contact ids, and why. */
export const NOT_CONTACT_STRING_REFERENCES: Readonly<Record<string, string>> = {};
