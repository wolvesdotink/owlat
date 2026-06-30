<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { extractFirstPartByType } from '@owlat/shared/mailMime';
import { parseICalendar, buildReplyICalendar, type ICalEvent, type Partstat } from '@owlat/shared/ical';
import { escapeHtml } from '@owlat/shared/html';

/**
 * Renders an iCalendar invite (a text/calendar or .ics part) as a card and
 * sends an RSVP — a reply to the organizer with a METHOD:REPLY .ics attached.
 */
const props = defineProps<{
	messageId: string;
	mailboxId: string;
	ownEmail?: string;
}>();

const stack = usePostboxComposerStack();
const { stash } = usePostboxPendingAttachments();

const event = ref<ICalEvent | null>(null);
const method = ref<string | undefined>(undefined);

onMounted(async () => {
	try {
		const bin = await loadRawEml(props.messageId);
		if (!bin) return;
		// Invites are commonly an inline text/calendar part (no disposition or
		// filename), so match by content-type rather than the attachment index.
		const part = extractFirstPartByType(bin, 'text/calendar');
		if (!part) return;
		const cal = parseICalendar(new TextDecoder('utf-8').decode(part.bytes));
		method.value = cal.method;
		event.value = cal.events[0] ?? null;
	} catch {
		// Leave the card hidden on a parse/fetch failure.
	}
});

function formatWhen(): string {
	const e = event.value;
	if (!e?.start?.date) return '';
	const start = e.start.date;
	let s = start.toLocaleString('en-US', e.start.allDay
		? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
		: { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	if (e.end?.date && !e.start.allDay) {
		s += ` – ${e.end.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
	}
	return s;
}

const canRsvp = computed(
	() => method.value === 'REQUEST' && !!event.value?.organizer?.email && !!props.ownEmail
);

function rsvp(status: Partstat) {
	const e = event.value;
	if (!e?.organizer?.email || !props.ownEmail) return;
	const reply = buildReplyICalendar(e, props.ownEmail, status, new Date());
	const key = stash({
		filename: 'reply.ics',
		contentType: 'text/calendar; method=REPLY; charset=utf-8',
		content: reply,
	});
	const prefix = status === 'ACCEPTED' ? 'Accepted' : status === 'DECLINED' ? 'Declined' : 'Tentative';
	const verb = status === 'ACCEPTED' ? 'accepted' : status === 'DECLINED' ? 'declined' : 'tentatively accepted';
	stack.open({
		mailboxId: props.mailboxId as Id<'mailboxes'>,
		prefillTo: [e.organizer.email],
		prefillSubject: `${prefix}: ${e.summary ?? 'Invitation'}`,
		prefillBodyHtml: `<p>I have ${verb} the invitation: <strong>${escapeHtml(e.summary ?? '')}</strong>.</p>`,
		attachPendingKey: key,
	});
}
</script>

<template>
	<div v-if="event" class="mt-3 border border-border-subtle rounded-lg p-4 bg-bg-surface">
		<div class="flex items-start gap-3">
			<Icon name="lucide:calendar" class="w-5 h-5 text-brand flex-shrink-0 mt-0.5" />
			<div class="flex-1 min-w-0">
				<p class="font-semibold text-text-primary">{{ event.summary || 'Invitation' }}</p>
				<p v-if="formatWhen()" class="text-sm text-text-secondary mt-0.5">{{ formatWhen() }}</p>
				<p v-if="event.location" class="text-sm text-text-tertiary mt-0.5 flex items-center gap-1">
					<Icon name="lucide:map-pin" class="w-3.5 h-3.5" />
					{{ event.location }}
				</p>
				<p
					v-if="event.organizer?.name || event.organizer?.email"
					class="text-xs text-text-tertiary mt-1"
				>
					Organizer: {{ event.organizer.name || event.organizer.email }}
					<span v-if="event.attendees.length > 0"> · {{ event.attendees.length }} attendee(s)</span>
				</p>
			</div>
		</div>
		<div v-if="canRsvp" class="flex items-center gap-2 mt-3">
			<button type="button" class="btn btn-ghost text-success" @click="rsvp('ACCEPTED')">
				<Icon name="lucide:check" class="w-4 h-4 mr-1" /> Accept
			</button>
			<button type="button" class="btn btn-ghost text-warning" @click="rsvp('TENTATIVE')">
				<Icon name="lucide:help-circle" class="w-4 h-4 mr-1" /> Maybe
			</button>
			<button type="button" class="btn btn-ghost text-error" @click="rsvp('DECLINED')">
				<Icon name="lucide:x" class="w-4 h-4 mr-1" /> Decline
			</button>
		</div>
	</div>
</template>
