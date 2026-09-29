/**
 * Contact vocabulary shared by the `contacts` table and the functions that
 * create contacts (contact resolution, the create API, webhook payloads).
 */

import { literalUnion } from '../literalUnion';

const CONTACT_SOURCE_LITERALS = ['api', 'import', 'form', 'transactional', 'inbound'] as const;

/** Where a contact came from (`contacts.source`). */
export type ContactSource = (typeof CONTACT_SOURCE_LITERALS)[number];

export const contactSourceValidator = literalUnion(CONTACT_SOURCE_LITERALS);

// Sources a caller may set when CREATING a contact. 'inbound' is excluded — it
// is assigned only internally the first time a contact appears via an inbound
// message, never accepted from the create API.
const CONTACT_CREATE_SOURCE_LITERALS = ['api', 'import', 'form', 'transactional'] as const;

export const contactCreateSourceValidator = literalUnion(CONTACT_CREATE_SOURCE_LITERALS);
