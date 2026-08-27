<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail, normalizeEmail } from '~/utils/validation';
import { canonicalEmailAddress, isExternalRecipient } from '~/utils/recipientHints';
import { suggestRecipientDomain, type DomainSuggestion } from '~/utils/recipientTypo';
import {
	findRecipientSealView,
	recipientSealGlyph,
	type RecipientSealGlyph,
	type RecipientSealView,
} from '~/utils/sealRecipients';
import { SEAL_TONE_CLASSES } from '~/utils/sealTone';

interface ContactSuggestion {
	email: string;
	displayName?: string;
}

type RecipientField = 'to' | 'cc' | 'bcc';

const props = withDefaults(
	defineProps<{
		modelValue: string[];
		mailboxId: Id<'mailboxes'>;
		label: string;
		/** Which envelope field this is — carried in drag payloads. */
		field?: RecipientField;
		/** The user's own domains; a chip outside them is flagged as external. */
		ownDomains?: string[];
		/**
		 * Domains this mailbox actually corresponds with — the first corpus the
		 * did-you-mean hint compares a freshly committed chip against.
		 */
		knownDomains?: string[];
		/**
		 * Recipients (across all envelope fields) this mailbox has never written
		 * to. Only ever non-empty once the backend has actually answered, so the
		 * "first time" cue never fires on a pending read.
		 */
		firstTimeAddresses?: string[];
		/**
		 * Per-recipient seal verdicts for THIS draft (plan idea 11), from
		 * `api.mail.drafts.getComposerSealState`. Empty — the default — when
		 * Sealed Mail is off, the answer has not arrived, or the aggregate verdict
		 * does not turn on recipient keys; the chips then say nothing about
		 * sealing, exactly as before. The composer decides when they may speak
		 * (`showsRecipientSealGlyphs`); this field only draws what it is given.
		 */
		sealStates?: RecipientSealView[];
	}>(),
	{
		field: 'to',
		ownDomains: () => [],
		knownDomains: () => [],
		firstTimeAddresses: () => [],
		sealStates: () => [],
	}
);

const emit = defineEmits<{
	(e: 'update:modelValue', value: string[]): void;
	(e: 'move', payload: { email: string; from: RecipientField }): void;
}>();

const { t } = useI18n();

const ownDomainLabel = computed(() => props.ownDomains[0] ?? '');
function isExternal(addr: string): boolean {
	return isExternalRecipient(addr, props.ownDomains);
}

// ─── First-time recipients (plan idea 5) ─────────────────────────────────────
// The composer resolves who is a stranger (one mailbox-wide read for all three
// fields); this component only marks the chips that are in that set.
const firstTimeSet = computed(() => new Set(props.firstTimeAddresses.map(canonicalEmailAddress)));
function isFirstTime(addr: string): boolean {
	return firstTimeSet.value.has(canonicalEmailAddress(addr));
}

// ─── Per-recipient seal state (plan idea 11) ─────────────────────────────────
// A lock / no-key glyph beside each chip, so a draft that cannot be sealed says
// WHICH recipient is keyless instead of only that someone is. The glyph is about
// that recipient's key, never about the message's fate — the aggregate lock
// below the envelope remains the only thing that speaks for the send.
// Resolved once per render pass rather than per template read: a chip touches
// its glyph several times (icon, tone, title, the "no key" tail).
const sealGlyphs = computed<Map<string, RecipientSealGlyph>>(() => {
	const glyphs = new Map<string, RecipientSealGlyph>();
	for (const addr of props.modelValue) {
		const view = findRecipientSealView(props.sealStates, addr);
		if (view) glyphs.set(addr, recipientSealGlyph(view));
	}
	return glyphs;
});

/** Resolve a glyph's `{ key, params }` title through the active locale. */
function sealGlyphTitle(glyph: RecipientSealGlyph): string {
	return typeof glyph.title === 'string'
		? t(glyph.title)
		: t(glyph.title.key, glyph.title.params ?? {});
}

// ─── Did you mean … ? (plan idea 4) ──────────────────────────────────────────
// Checked once, on chip commit — the moment the address becomes real — and shown
// as an inline hint with a one-click fix. It NEVER blocks: a domain we don't
// recognise is a suggestion, not a verdict, and the sender may well be right.
const suggestion = ref<DomainSuggestion | null>(null);

function checkForTypo(committed: string) {
	suggestion.value = suggestRecipientDomain(committed, props.knownDomains);
}

/** Swap the mistyped chip for the suggested one, keeping its position. */
function applySuggestion() {
	const fix = suggestion.value;
	suggestion.value = null;
	if (!fix) return;
	const index = props.modelValue.findIndex((addr) => canonicalEmailAddress(addr) === fix.mistyped);
	if (index < 0) return;
	const next = [...props.modelValue];
	// The corrected address may already be a chip (the sender typed it twice,
	// once with the slip) — then the fix is simply dropping the mistyped one.
	const duplicate = next.some(
		(addr, i) => i !== index && canonicalEmailAddress(addr) === fix.address
	);
	if (duplicate) next.splice(index, 1);
	else next[index] = fix.address;
	emit('update:modelValue', next);
}

/** "Keep as typed" — the sender knows the domain; stop asking about it. */
function dismissSuggestion() {
	suggestion.value = null;
}

// ─── Drag a chip out of this field (dropped onto another) ────────────────────
function onChipDragStart(event: DragEvent, addr: string) {
	if (!event.dataTransfer) return;
	event.dataTransfer.effectAllowed = 'move';
	event.dataTransfer.setData(
		'application/x-postbox-recipient',
		JSON.stringify({ email: addr, from: props.field })
	);
}
function onFieldDrop(event: DragEvent) {
	const raw = event.dataTransfer?.getData('application/x-postbox-recipient');
	if (!raw) return;
	event.preventDefault();
	try {
		const payload = JSON.parse(raw) as { email: string; from: RecipientField };
		if (payload.email && payload.from && payload.from !== props.field) {
			emit('move', payload);
		}
	} catch {
		// Ignore a malformed / foreign drag payload.
	}
}

const inputValue = ref('');
const showSuggestions = ref(false);
const highlightIdx = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

// Debounce the prefix so each keystroke doesn't re-subscribe the autocomplete
// query (and re-scan contacts on the backend).
const debouncedPrefix = ref('');
let prefixTimer: ReturnType<typeof setTimeout> | null = null;
watch(inputValue, (v) => {
	if (prefixTimer) clearTimeout(prefixTimer);
	prefixTimer = setTimeout(() => {
		debouncedPrefix.value = v.trim();
	}, 200);
});
onScopeDispose(() => {
	if (prefixTimer) clearTimeout(prefixTimer);
});

// Live autocomplete query — fires only once the debounced prefix has a value.
const { data: suggestionsData } = useConvexQuery(api.mail.contacts.autocomplete, () => {
	const v = debouncedPrefix.value;
	if (!v) return 'skip';
	return { mailboxId: props.mailboxId, prefix: v, limit: 6 };
});
const suggestions = computed<ContactSuggestion[]>(() =>
	(suggestionsData.value ?? []).filter((s) => !props.modelValue.includes(s.email))
);

watch(suggestions, () => {
	highlightIdx.value = 0;
});

function addRecipient(email: string) {
	const trimmed = normalizeEmail(email);
	if (!trimmed) return;
	if (!isValidEmail(trimmed)) return;
	if (props.modelValue.includes(trimmed)) return;
	emit('update:modelValue', [...props.modelValue, trimmed]);
	inputValue.value = '';
	showSuggestions.value = false;
	checkForTypo(trimmed);
}

function removeRecipient(idx: number) {
	const next = [...props.modelValue];
	const [removed] = next.splice(idx, 1);
	// A hint about a chip that is gone is noise.
	if (removed && canonicalEmailAddress(removed) === suggestion.value?.mistyped) {
		suggestion.value = null;
	}
	emit('update:modelValue', next);
}

/** Pop the last chip off and load it into the input for editing. */
function editLastChip() {
	const last = props.modelValue[props.modelValue.length - 1];
	if (last === undefined) return;
	emit('update:modelValue', props.modelValue.slice(0, -1));
	inputValue.value = last;
	showSuggestions.value = false;
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
		event.preventDefault();
		if (showSuggestions.value && suggestions.value.length > 0) {
			const hit = suggestions.value[highlightIdx.value];
			if (hit) addRecipient(hit.email);
		} else if (inputValue.value.trim()) {
			addRecipient(inputValue.value);
		}
		return;
	}
	if (event.key === 'Backspace' && !inputValue.value && props.modelValue.length > 0) {
		// Gmail behavior: pop the last chip back into the input as editable text
		// rather than deleting it outright, so a mistyped recipient is fixable.
		event.preventDefault();
		editLastChip();
		return;
	}
	if (event.key === 'ArrowDown' && suggestions.value.length > 0) {
		event.preventDefault();
		highlightIdx.value = (highlightIdx.value + 1) % suggestions.value.length;
		return;
	}
	if (event.key === 'ArrowUp' && suggestions.value.length > 0) {
		event.preventDefault();
		highlightIdx.value =
			(highlightIdx.value - 1 + suggestions.value.length) % suggestions.value.length;
		return;
	}
	if (event.key === 'Escape') {
		showSuggestions.value = false;
	}
}

function onInput() {
	showSuggestions.value = !!inputValue.value.trim();
}

function onBlur() {
	// Defer so click on suggestion still fires
	setTimeout(() => {
		showSuggestions.value = false;
		if (inputValue.value.trim() && isValidEmail(inputValue.value.trim())) {
			addRecipient(inputValue.value);
		}
	}, 150);
}
</script>

<template>
	<div class="flex items-baseline gap-2 relative">
		<label class="text-text-tertiary w-12 flex-shrink-0">{{ label }}</label>
		<div
			class="flex flex-wrap items-center gap-1 flex-1 min-h-[1.5rem]"
			@dragover.prevent
			@drop="onFieldDrop"
		>
			<span
				v-for="(addr, idx) in modelValue"
				:key="addr"
				draggable="true"
				class="inline-flex items-center gap-1 pl-0.5 pr-2 py-0.5 rounded-full bg-bg-surface text-xs cursor-grab active:cursor-grabbing"
				:class="isExternal(addr) ? 'ring-1 ring-warning/70' : ''"
				:title="
					isExternal(addr) && ownDomainLabel
						? t('components.postbox.postboxRecipientField.outsideDomain', {
								domain: ownDomainLabel,
							})
						: undefined
				"
				@dragstart="onChipDragStart($event, addr)"
			>
				<UiAvatar
					:email="addr"
					deterministic-color
					size="xs"
					class="flex-shrink-0"
					aria-hidden="true"
				/>
				<!-- Plan idea 11: this recipient's own sealing key. Absent unless the
				     composer decided the chips may speak about sealing at all. -->
				<template v-if="sealGlyphs.get(addr)">
					<Icon
						:name="sealGlyphs.get(addr)!.icon"
						class="w-3 h-3 flex-shrink-0"
						:class="SEAL_TONE_CLASSES[sealGlyphs.get(addr)!.tone].icon"
						:data-testid="`postbox-chip-seal-${sealGlyphs.get(addr)!.kind}`"
						:title="sealGlyphTitle(sealGlyphs.get(addr)!)"
						:aria-label="sealGlyphTitle(sealGlyphs.get(addr)!)"
					/>
					{{ addr }}
					<!-- Named, not just glyphed: with several chips the sender has to
					     read who is keyless without hovering each one. -->
					<span
						v-if="sealGlyphs.get(addr)!.kind === 'noKey'"
						class="text-text-tertiary"
						data-testid="postbox-chip-no-key"
					>
						· {{ t('components.postbox.postboxRecipientField.noSealingKey') }}
					</span>
				</template>
				<template v-else>{{ addr }}</template>
				<!-- Plan idea 5: never written to this address before. A cue, not a
				     warning — it only says what it actually knows. -->
				<span
					v-if="isFirstTime(addr)"
					class="text-text-tertiary"
					data-testid="postbox-first-time-chip"
					:title="t('components.postbox.postboxRecipientField.firstTimeTitle', { address: addr })"
				>
					· {{ t('components.postbox.postboxRecipientField.firstTime') }}
				</span>
				<button
					type="button"
					class="text-text-tertiary hover:text-text-primary"
					@click="removeRecipient(idx)"
					:aria-label="
						t('components.postbox.postboxRecipientField.removeRecipient', { address: addr })
					"
				>
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
			</span>
			<input
				ref="inputEl"
				v-model="inputValue"
				type="text"
				class="flex-1 min-w-[120px] bg-transparent outline-none text-sm"
				:placeholder="
					modelValue.length === 0 ? t('components.postbox.postboxRecipientField.placeholder') : ''
				"
				@input="onInput"
				@focus="onInput"
				@blur="onBlur"
				@keydown="onKeydown"
			/>
			<!-- Plan idea 4: the committed chip's domain is one or two slips away
			     from a domain this mailbox writes to (or a common provider). Inline,
			     one click to fix, one to keep — it never blocks the send. -->
			<div
				v-if="suggestion"
				class="basis-full flex flex-wrap items-center gap-1.5 pt-1 text-xs text-text-tertiary"
				data-testid="postbox-domain-suggestion"
			>
				<Icon name="lucide:help-circle" class="w-3.5 h-3.5 shrink-0 text-warning" />
				<span>
					{{
						t('components.postbox.postboxRecipientField.didYouMean', {
							address: suggestion.address,
						})
					}}
				</span>
				<button type="button" class="text-brand hover:underline" @click="applySuggestion">
					{{ t('components.postbox.postboxRecipientField.fixIt') }}
				</button>
				<span aria-hidden="true">·</span>
				<button
					type="button"
					class="text-text-tertiary hover:text-text-primary"
					@click="dismissSuggestion"
				>
					{{ t('components.postbox.postboxRecipientField.keepAsTyped') }}
				</button>
			</div>
		</div>
		<div
			v-if="showSuggestions && suggestions.length > 0"
			data-postbox-overlay-open
			class="absolute top-full left-12 mt-1 bg-bg-elevated border border-border-subtle rounded shadow-lg w-80 max-w-[90%] z-20"
		>
			<button
				v-for="(s, idx) in suggestions"
				:key="s.email"
				type="button"
				class="w-full text-left px-3 py-1.5 text-sm hover:bg-bg-surface flex items-center gap-2"
				:class="idx === highlightIdx ? 'bg-bg-surface-hover' : ''"
				@mouseenter="highlightIdx = idx"
				@mousedown.prevent
				@click="addRecipient(s.email)"
			>
				<UiAvatar
					:name="s.displayName"
					:email="s.email"
					deterministic-color
					size="sm"
					class="flex-shrink-0"
					aria-hidden="true"
				/>
				<span class="truncate">
					<span v-if="s.displayName" class="font-medium">{{ s.displayName }}</span>
					<span v-if="s.displayName" class="text-text-tertiary ml-1">&lt;{{ s.email }}&gt;</span>
					<span v-else>{{ s.email }}</span>
				</span>
			</button>
		</div>
	</div>
</template>
