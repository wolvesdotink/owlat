/**
 * The attachment ceilings only mean something in relation to each other.
 *
 * A per-attachment AI-ingest ceiling above what the port-25 listener can
 * deliver is not a gate — it is a comment. That was the state before this
 * suite: the ceiling was 10 MiB and so was the whole-message cap, so no part
 * that ever arrived could trip it, and raising the listener cap later would
 * have moved AI policy silently along with it. Pinned here the way the
 * retention-day choices are pinned against their validator.
 */
import { describe, it, expect } from 'vitest';
import {
	MAX_AI_INGEST_ATTACHMENT_BYTES,
	MAX_ATTACHMENT_BYTES,
	MAX_INBOUND_MESSAGE_BYTES,
} from '../attachments';

/**
 * The largest single attachment a message at the listener cap can carry.
 * Attachment leaves travel base64 — 4 wire bytes per 3 bytes of content — and
 * the message also carries headers, a body and the other parts, so three
 * quarters of the envelope is a generous upper bound.
 */
const MAX_DELIVERABLE_ATTACHMENT_BYTES = Math.floor((MAX_INBOUND_MESSAGE_BYTES * 3) / 4);

describe('attachment ceilings', () => {
	it('keeps the AI-ingest ceiling below the largest part the wire can deliver', () => {
		// The one that matters: a message at the listener cap carries at most
		// ~7.5 MiB of decoded attachment, so a ceiling at or above that can never
		// refuse anything.
		expect(MAX_AI_INGEST_ATTACHMENT_BYTES).toBeLessThan(MAX_DELIVERABLE_ATTACHMENT_BYTES);
		expect(MAX_AI_INGEST_ATTACHMENT_BYTES).toBeLessThan(MAX_INBOUND_MESSAGE_BYTES);
	});

	it('keeps the stored-attachment cap above the AI-ingest one', () => {
		// Over the AI ceiling a file still arrives, still lists and still
		// downloads; over the storage cap it is not kept at all. Inverting the two
		// would mean nothing is ever "stored but unread".
		expect(MAX_AI_INGEST_ATTACHMENT_BYTES).toBeLessThan(MAX_ATTACHMENT_BYTES);
	});
});
