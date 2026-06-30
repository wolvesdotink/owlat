import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { formFieldValidator, jsonPrimitiveRecord } from '../lib/convexValidators';

/**
 * Form tables — embeddable signup-form endpoints + submission audit log.
 *
 * Spread into `defineSchema()` from schema.ts via `...formTables`.
 */
export const formTables = {
	// Form Endpoints - public signup forms for collecting email subscribers
	formEndpoints: defineTable({
		name: v.string(), // User-friendly name for the form
		// Which topic to subscribe contacts to
		topicId: v.optional(v.id('topics')),
		// Form fields configuration
		fields: v.array(formFieldValidator),
		// Optional redirect URL after successful submission
		redirectUrl: v.optional(v.string()),
		// Honeypot field name for spam prevention (if different from default "_hp_field")
		honeypotFieldName: v.optional(v.string()),
		// Whether the form endpoint is active
		isActive: v.boolean(),
		// Double opt-in: require email confirmation before subscribing
		doubleOptIn: v.optional(v.boolean()),
		// Stats — denormalized counters maintained by writers in
		// `forms/submission.ts`. The list/detail queries previously did
		// `collect()` + JS filter per form to compute these; reading the
		// counter avoids fanning out to `formSubmissions` per render.
		submissionCount: v.optional(v.number()),
		successfulSubmissionCount: v.optional(v.number()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_active', ['isActive']),

	// Form Submissions - tracks form submissions for analytics
	formSubmissions: defineTable({
		formEndpointId: v.id('formEndpoints'),
		// Contact that was created or updated (if any)
		contactId: v.optional(v.id('contacts')),
		// Submission data (submitted fields). Parsed form values arrive as
		// `Record<string, string>` from the form encoder.
		data: jsonPrimitiveRecord,
		// Whether the submission was successful
		status: v.union(
			v.literal('success'),
			v.literal('pending_confirmation'), // Awaiting double opt-in confirmation
			v.literal('duplicate'), // Contact already existed
			v.literal('spam'), // Honeypot triggered
			v.literal('invalid') // Validation failed
		),
		// IP address (for rate limiting / spam detection)
		ipAddress: v.optional(v.string()),
		// User agent
		userAgent: v.optional(v.string()),
		// Error message if status is invalid
		errorMessage: v.optional(v.string()),
		// Double opt-in confirmation token (for pending_confirmation status)
		confirmationToken: v.optional(v.string()),
		// When the confirmation email was sent
		confirmationEmailSentAt: v.optional(v.number()),
		// When the user confirmed their subscription
		confirmedAt: v.optional(v.number()),
		// Timestamp
		submittedAt: v.number(),
	})
		.index('by_form_endpoint', ['formEndpointId'])
		.index('by_contact', ['contactId'])
		.index('by_status', ['status'])
		.index('by_form_endpoint_and_status', ['formEndpointId', 'status'])
		.index('by_confirmation_token', ['confirmationToken'])
		.index('by_submitted_at', ['submittedAt']),
};
