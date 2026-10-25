/**
 * The plain types the SDK re-exports and the schemas the server validates
 * with describe the same wire shapes. These are compile-time checks: the
 * package typecheck fails when one side changes without the other.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type {
	apiErrorResponseSchema,
	healthStatusSchema,
	jsonPrimitiveSchema,
	paginationMetaSchema,
} from '../common';
import type {
	contactSchema,
	createContactRequestSchema,
	deleteContactResponseSchema,
	updateContactRequestSchema,
} from '../contacts';
import type { sendEventRequestSchema, sendEventResponseSchema } from '../events';
import type {
	addContactToTopicRequestSchema,
	addToTopicResponseSchema,
	removeFromTopicResponseSchema,
} from '../topics';
import type {
	sendTransactionalRequestSchema,
	sendTransactionalResponseSchema,
	transactionalAttachmentSchema,
} from '../transactional';
import type * as T from '../types';

/**
 * A request type agrees with its schema when every value the type allows is
 * accepted (the SDK never sends what the server refuses) and both name the
 * same fields (no field is missing from either side). The type may be
 * narrower: a schema can accept `null` where the SDK never sends it.
 */
type Equal<A, B> =
	(<V>() => V extends A ? 1 : 2) extends <V>() => V extends B ? 1 : 2 ? true : false;
type RequestAgrees<Type, Schema extends z.ZodType> = [Type] extends [z.input<Schema>]
	? Equal<keyof Type, keyof z.input<Schema>> extends true
		? // No defaults or transforms: the decoder hands back the request as sent.
			Equal<z.input<Schema>, z.output<Schema>>
		: 'fields differ'
	: 'type allows what the schema refuses';

describe('schema and type agreement', () => {
	it('responses are exactly their types', () => {
		expectTypeOf<z.output<typeof contactSchema>>().toEqualTypeOf<T.Contact>();
		expectTypeOf<
			z.output<typeof deleteContactResponseSchema>
		>().toEqualTypeOf<T.DeleteContactResponse>();
		expectTypeOf<z.output<typeof sendEventResponseSchema>>().toEqualTypeOf<T.SendEventResponse>();
		expectTypeOf<
			z.output<typeof sendTransactionalResponseSchema>
		>().toEqualTypeOf<T.SendTransactionalResponse>();
		expectTypeOf<z.output<typeof addToTopicResponseSchema>>().toEqualTypeOf<T.AddToTopicResponse>();
		expectTypeOf<
			z.output<typeof removeFromTopicResponseSchema>
		>().toEqualTypeOf<T.RemoveFromTopicResponse>();
		expectTypeOf<z.output<typeof healthStatusSchema>>().toEqualTypeOf<T.HealthStatus>();
		expectTypeOf<z.output<typeof paginationMetaSchema>>().toEqualTypeOf<T.PaginationMeta>();
		expectTypeOf<z.output<typeof apiErrorResponseSchema>>().toEqualTypeOf<T.ApiErrorResponse>();
		expectTypeOf<z.output<typeof jsonPrimitiveSchema>>().toEqualTypeOf<T.JsonPrimitive>();
	});

	it('requests agree with their types', () => {
		expectTypeOf<
			RequestAgrees<T.CreateContactRequest, typeof createContactRequestSchema>
		>().toEqualTypeOf<true>();
		expectTypeOf<
			RequestAgrees<T.UpdateContactRequest, typeof updateContactRequestSchema>
		>().toEqualTypeOf<true>();
		expectTypeOf<
			RequestAgrees<T.SendEventRequest, typeof sendEventRequestSchema>
		>().toEqualTypeOf<true>();
		expectTypeOf<
			RequestAgrees<T.SendTransactionalRequest, typeof sendTransactionalRequestSchema>
		>().toEqualTypeOf<true>();
		expectTypeOf<
			RequestAgrees<T.TransactionalAttachment, typeof transactionalAttachmentSchema>
		>().toEqualTypeOf<true>();
		expectTypeOf<
			RequestAgrees<T.AddContactToTopicRequest, typeof addContactToTopicRequestSchema>
		>().toEqualTypeOf<true>();
	});

	it('template variables and event properties hold primitives only', () => {
		type Variables = NonNullable<T.SendTransactionalRequest['dataVariables']>;
		type Properties = NonNullable<T.SendEventRequest['eventProperties']>;
		expectTypeOf<{ a: string; b: number; c: boolean; d: null }>().toExtend<Variables>();
		expectTypeOf<{ nested: { a: string } }>().not.toExtend<Variables>();
		expectTypeOf<{ list: string[] }>().not.toExtend<Variables>();
		expectTypeOf<{ nested: { a: string } }>().not.toExtend<Properties>();
		expectTypeOf<{ list: number[] }>().not.toExtend<Properties>();
	});

	it('a contact source includes inbound', () => {
		expectTypeOf<'inbound'>().toExtend<T.ContactSource>();
	});
});
