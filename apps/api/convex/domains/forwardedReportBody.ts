import { v, type Infer } from 'convex/values';

/**
 * The body the MTA forwards for a mailed report (TLS-RPT, DMARC aggregate):
 * the parsed message, of which these routes read only the attachments. Every
 * field is optional, so a message without attachments is acknowledged as one
 * carrying no report rather than refused, and the message's other fields
 * (headers, bodies, auth verdicts) are left unread.
 */
export const forwardedReportBody = v.object({
	attachments: v.optional(
		v.array(
			v.object({
				filename: v.optional(v.string()),
				contentType: v.optional(v.string()),
				/** base64 */
				content: v.optional(v.string()),
			})
		)
	),
});

export type ForwardedAttachment = NonNullable<
	Infer<typeof forwardedReportBody>['attachments']
>[number];
