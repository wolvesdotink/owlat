<script setup lang="ts">
/**
 * Compact, copy-friendly DNS record table for the server-setup flow.
 *
 * Each hostname/value is a `select-all` token (one click selects just that
 * cell — selection never drags across the row or spans the panel width), and
 * every row has a copy button that copies the record's VALUE (the target the
 * operator pastes into their DNS provider). The copy affordance swaps icon in
 * place, so the feedback causes no layout shift.
 *
 * A record may be a `placeholder` (its value is not a real address yet — e.g.
 * the server IP is unknown). Those render muted with the copy button disabled
 * so the user never pastes a literal "your server's IP" placeholder.
 */
interface DnsRecord {
	name: string;
	type: string;
	value: string;
	/** True when `value` is a placeholder (no real address) — copy is disabled. */
	placeholder?: boolean;
	/** Optional inline note shown under the row. */
	note?: string;
}

defineProps<{ records: DnsRecord[] }>();

const { copy, isCopied } = useCopyToClipboard();
const keyOf = (r: DnsRecord) => `${r.name}/${r.type}`;
</script>

<template>
	<div class="grid grid-cols-[auto_auto_1fr_auto] items-center gap-x-3 gap-y-1.5 font-mono text-xs">
		<template v-for="r in records" :key="keyOf(r)">
			<span class="select-all whitespace-nowrap text-text-primary">{{ r.name }}</span>
			<span
				class="select-none rounded bg-bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase text-text-secondary"
			>
				{{ r.type }}
			</span>
			<span
				class="select-all whitespace-nowrap"
				:class="r.placeholder ? 'italic text-amber-300' : 'text-text-secondary'"
				>{{ r.value }}</span
			>
			<button
				v-if="!r.placeholder"
				type="button"
				class="flex size-6 items-center justify-center justify-self-end rounded text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:aria-label="`Copy value for ${r.name}`"
				:title="isCopied(keyOf(r)) ? 'Copied' : `Copy value for ${r.name}`"
				@click="copy(r.value, keyOf(r))"
			>
				<Icon
					:name="isCopied(keyOf(r)) ? 'lucide:check' : 'lucide:copy'"
					class="size-3.5"
					:class="isCopied(keyOf(r)) ? 'text-emerald-400' : ''"
				/>
			</button>
			<span
				v-else
				class="flex size-6 items-center justify-center justify-self-end text-text-tertiary"
				:title="`Set the server's public IP to copy the value for ${r.name}`"
			>
				<Icon name="lucide:copy" class="size-3.5 opacity-30" />
			</span>
			<p
				v-if="r.note"
				class="col-span-4 -mt-0.5 font-sans text-[11px] leading-snug text-text-tertiary"
			>
				{{ r.note }}
			</p>
		</template>
	</div>
</template>
