/**
 * What PostboxThreadReader knows about each message of the open conversation,
 * beyond the row itself: its PGP/S-MIME structure, the tracking pixels its body
 * reported, its calendar invite, the delivery evidence for mail we sent,
 * whether it gets the "draft a reply?" scheduling chip, and how its card
 * renders (relative time, forced light, remote images). One subscription or
 * map per conversation rather than one per message card.
 */
import { computed, ref, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	classifySecureMessage,
	isEncryptedClass,
	type SecureMessageClass,
} from '@owlat/shared/secureMessage';
import type { TrackerDetection } from '@owlat/shared/postboxTrackers';
import type { OutboundDelivery } from '~/utils/postboxDeliveryStrip';
import { shouldShowSchedulingChip } from '~/utils/postboxSchedulingChip';
import { formatCompactRelativeTime } from '~/utils/formatters';
import { useNow } from '~/composables/useNow';

type FactsMessage = {
	_id: string;
	attachments: Array<{ filename: string; contentType: string; partIndex?: string }>;
	textBodyInline?: string;
};

export function usePostboxReaderMessageFacts(source: {
	messageId: Ref<Id<'mailMessages'>>;
	mailboxId: Ref<Id<'mailboxes'>>;
	messages: Ref<FactsMessage[]>;
	/** The open thread as the thread page query returned it. */
	thread: () => unknown;
	aiEnabled: () => boolean;
}) {
	// PGP/S-MIME structure per message (detection only — see PostboxSecurityBadge),
	// classified once per thread change rather than on every template re-render.
	const secureClassMap = computed(() => {
		const map = new Map<string, SecureMessageClass>();
		for (const m of source.messages.value) {
			map.set(
				m._id,
				classifySecureMessage({ attachments: m.attachments, textBody: m.textBodyInline })
			);
		}
		return map;
	});
	function secureClass(msg: { _id: string }): SecureMessageClass {
		return secureClassMap.value.get(msg._id) ?? 'none';
	}
	/** Hide the raw body when it's encrypted (gibberish) or clearsigned (the badge
	 * shows the readable cleartext instead). */
	function hideRawBody(msg: { _id: string }): boolean {
		const c = secureClass(msg);
		return isEncryptedClass(c) || c === 'pgp-clearsigned';
	}

	// Tracking-pixel detections reported by each message body (fail-soft: a
	// message with no report simply shows no badge).
	const trackerDetections = ref<Record<string, TrackerDetection>>({});
	function onTrackersDetected(msgId: string, detection: TrackerDetection) {
		trackerDetections.value[msgId] = detection;
	}
	function trackerDetection(msg: { _id: string }): TrackerDetection | null {
		const detection = trackerDetections.value[msg._id];
		return detection && detection.pixelCount > 0 ? detection : null;
	}

	/** The text/calendar (.ics) attachment of a message, if it carries an invite. */
	function calendarAttachment(msg: {
		attachments: Array<{ filename: string; contentType: string; partIndex?: string }>;
	}) {
		return msg.attachments?.find(
			(a) =>
				a.contentType.toLowerCase().includes('calendar') ||
				a.filename.toLowerCase().endsWith('.ics')
		);
	}

	// Per-recipient delivery evidence for the messages WE sent in this thread (plan
	// idea 1). One subscription for the whole conversation rather than one per
	// message; an inbound-only thread gets an empty array and renders no strip.
	const { data: outboundDelivery } = useConvexQuery(
		api.mail.mailbox.messages.listThreadOutboundDelivery,
		() => ({ messageId: source.messageId.value })
	);
	const deliveryByMessage = computed(() => {
		const map = new Map<string, OutboundDelivery>();
		for (const row of outboundDelivery.value ?? []) {
			map.set(row.messageId, { state: row.state, recipients: row.recipients });
		}
		return map;
	});
	function deliveryFor(msg: { _id: string }): OutboundDelivery | null {
		return deliveryByMessage.value.get(msg._id) ?? null;
	}

	// A plain-prose scheduling request stashed on the thread: the quiet "draft a reply?"
	// chip, never beside a real .ics invite, dismissible per message for the session.
	const schedulingIntent = computed(() => {
		const needsReply = (
			source.thread() as
				| {
						needsReply?: {
							messageId?: string;
							meetingIntent?: {
								isScheduling: boolean;
								proposedTimes: string[];
								topic?: string;
							};
						};
				  }
				| null
				| undefined
		)?.needsReply;
		if (!needsReply?.meetingIntent?.isScheduling) return null;
		return {
			messageId: needsReply.messageId,
			proposedTimes: needsReply.meetingIntent.proposedTimes ?? [],
		};
	});

	const dismissedScheduling = ref(new Set<string>());
	function dismissScheduling(messageId: string) {
		dismissedScheduling.value = new Set(dismissedScheduling.value).add(messageId);
	}
	/**
	 * The proposed times to offer under `msg`, or null when this message gets no
	 * scheduling chip at all (no intent, wrong message, dismissed, AI off, or a real
	 * .ics invite is attached — PostboxInviteCard owns that case).
	 */
	function schedulingTimesFor(msg: {
		_id: string;
		attachments: Array<{ filename: string; contentType: string; partIndex?: string }>;
	}): string[] | null {
		const intent = schedulingIntent.value;
		const show = shouldShowSchedulingChip({
			aiEnabled: source.aiEnabled(),
			meetingIntent: intent ? { isScheduling: true, proposedTimes: intent.proposedTimes } : null,
			triggerMessageId: intent?.messageId,
			message: msg,
			dismissed: dismissedScheduling.value,
		});
		return show ? (intent?.proposedTimes ?? []) : null;
	}

	// Minute tick so the relative timestamps ("2h ago") stay fresh while a
	// thread sits open. Presentation-only; the absolute datetime lives in the
	// title tooltip.
	const relativeTimeNow = useNow({ intervalMs: 60_000 });
	function relativeReceivedAt(timestamp: number): string {
		// Touch the clock so the computed template bindings re-run each minute.
		void relativeTimeNow.value;
		return formatCompactRelativeTime(timestamp);
	}

	// Adaptive dark rendering: per-message sun/moon escape hatch (in-memory only)
	// forcing light rendering for a single message while the app is dark.
	const { isForcedLight, toggleForcedLight } = usePostboxForcedLight();

	// Per-sender remote-image allowlist. One subscription for the whole thread —
	// every message body asks this the same question, and a per-body query would
	// open one subscription per rendered message.
	const imageAllowlist = usePostboxImageAllowlist(source.mailboxId);

	return {
		secureClass,
		hideRawBody,
		onTrackersDetected,
		trackerDetection,
		calendarAttachment,
		deliveryFor,
		dismissScheduling,
		schedulingTimesFor,
		relativeReceivedAt,
		isForcedLight,
		toggleForcedLight,
		imageAllowlist,
	};
}
