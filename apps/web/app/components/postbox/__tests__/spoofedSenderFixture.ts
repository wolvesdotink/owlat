/**
 * A message row shaped like a phishing attempt, shared by the sender-trust
 * marker tests: a known-looking finance sender with a failed DMARC verdict
 * under a `reject` policy, the verdict every message renderer has to mark.
 * `BASE_MESSAGE` is the same row with no verdicts at all (a legacy row).
 */
import type { Id } from '@owlat/api/dataModel';
import type { PostboxThreadRowMessage } from '../PostboxThreadRow.vue';

export const BASE_MESSAGE: PostboxThreadRowMessage = {
	_id: 'msg-1' as Id<'mailMessages'>,
	fromAddress: 'billing@brightpath-finance.co',
	fromName: 'Brightpath Finance',
	subject: 'Urgent: update your payment details',
	snippet: 'Your account will be suspended unless…',
	receivedAt: 1_700_000_000_000,
	flagSeen: false,
	flagFlagged: false,
	hasAttachments: false,
};

export const SPOOFED_SENDER_MESSAGE: PostboxThreadRowMessage = {
	...BASE_MESSAGE,
	dmarcResult: 'fail',
	dmarcPolicy: 'reject',
};
