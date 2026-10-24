/**
 * Contacts: `/api/v1/contacts` and `/api/v1/contacts/{id}`.
 *
 * The schemas check shape only. Email syntax and the name length cap belong
 * to the server's own validators, which the handlers apply after decoding.
 */

import { z } from 'zod';
import { optionalString, requestBody, requiredString } from './common';
import { CONTACT_SOURCES } from './types';

export const contactSchema = z.strictObject({
	id: z.string(),
	email: z.string(),
	firstName: z.string().nullable(),
	lastName: z.string().nullable(),
	source: z.enum(CONTACT_SOURCES),
	createdAt: z.string().meta({ description: 'ISO 8601 timestamp.' }),
	updatedAt: z.string().meta({ description: 'ISO 8601 timestamp.' }),
});

export const createContactRequestSchema = requestBody({
	email: requiredString('Email is required', 'Email must be a string'),
	firstName: optionalString('firstName must be a string'),
	lastName: optionalString('lastName must be a string'),
});

export const updateContactRequestSchema = requestBody({
	email: optionalString('email must be a string'),
	firstName: optionalString('firstName must be a string'),
	lastName: optionalString('lastName must be a string'),
});

export const deleteContactResponseSchema = z.strictObject({
	id: z.string(),
	deleted: z.boolean(),
});
