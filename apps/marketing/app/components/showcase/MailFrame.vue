<script setup lang="ts">
/* In-code mock of the Postbox mail client. Mirrors the real three-pane
 * anatomy (apps/web/app/components/postbox/PostboxLayout.vue: folder rail →
 * thread list → reader) and echoes apps/api/convex/seedDemo fixtures.
 * Decorative only — the parent section carries aria-hidden + an sr-only
 * description. Swap the mock for a real capture by replacing this component's
 * body with an <img> inside <ShowcaseWindowFrame>. */

const { t } = useI18n();

const folders = [
	{
		id: 'inbox',
		nameKey: 'showcase.mail.folders.inbox',
		count: 3,
		active: true,
		paths: [
			'M22 12h-6l-2 3h-4l-2-3H2',
			'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
		],
	},
	{
		id: 'replyQueue',
		nameKey: 'showcase.mail.folders.replyQueue',
		count: 2,
		paths: ['m9 17-5-5 5-5', 'M20 18v-2a4 4 0 0 0-4-4H4'],
	},
	{
		id: 'drafts',
		nameKey: 'showcase.mail.folders.drafts',
		paths: ['M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z', 'M15 3v6h6'],
	},
	{
		id: 'sent',
		nameKey: 'showcase.mail.folders.sent',
		paths: ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4z'],
	},
	{
		id: 'archive',
		nameKey: 'showcase.mail.folders.archive',
		paths: ['M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8', 'M2 3h20v5H2z', 'M10 12h4'],
	},
	{
		id: 'spam',
		nameKey: 'showcase.mail.folders.spam',
		paths: [
			'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
			'M12 9v4',
			'M12 17h.01',
		],
	},
	{
		id: 'trash',
		nameKey: 'showcase.mail.folders.trash',
		paths: [
			'M3 6h18',
			'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
			'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
		],
	},
];

/* Sender/subject/snippet/time started from seedDemo/fixtures/mailboxMessages.json
 * and now live in i18n/locales/*.json under `showcase.mail.threads.*`: a mock
 * inbox that stays English on a German page reads like a screenshot of somebody
 * else's product. Names are kept identical across locales. */
const threads = [
	{ id: 'ben', unread: true },
	{ id: 'priya', unread: true },
	{ id: 'mia', unread: false, selected: true },
	{ id: 'ada', unread: false },
];
</script>

<template>
	<ShowcaseWindowFrame url="app.owlat.app/dashboard/postbox">
		<div class="flex h-[340px] max-md:h-[300px] text-left">
			<!-- Pane 1: folder rail -->
			<aside
				class="w-[124px] max-md:w-[104px] shrink-0 border-r border-border-subtle bg-surface-1 p-2 flex flex-col gap-1.5"
			>
				<div
					class="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-3 px-2 py-1 text-[8px] text-text-disabled"
				>
					<svg
						width="8"
						height="8"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
					>
						<circle cx="11" cy="11" r="8" />
						<path d="m21 21-4.3-4.3" />
					</svg>
					{{ t('showcase.mail.search') }}
				</div>
				<div
					class="rounded-full bg-text-primary text-text-inverse text-[8px] font-medium text-center py-1 mb-1"
				>
					{{ t('showcase.mail.compose') }}
				</div>
				<div
					v-for="folder in folders"
					:key="folder.id"
					class="flex items-center gap-1.5 rounded px-1.5 py-[3px] text-[8.5px]"
					:class="
						folder.active ? 'bg-bg-surface font-medium text-text-primary' : 'text-text-secondary'
					"
				>
					<svg
						width="9"
						height="9"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="shrink-0"
						:class="folder.active ? 'text-brand' : 'text-text-tertiary'"
					>
						<path v-for="(d, i) in folder.paths" :key="i" :d="d" />
					</svg>
					<span class="flex-1 truncate">{{ t(folder.nameKey) }}</span>
					<span v-if="folder.count" class="text-[7.5px] font-medium text-text-tertiary">
						{{ folder.count }}
					</span>
				</div>
			</aside>

			<!-- Pane 2: thread list -->
			<div
				class="w-[212px] max-md:w-[168px] shrink-0 border-r border-border-subtle bg-surface-2 flex flex-col"
			>
				<div class="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
					<span class="text-[9px] font-semibold text-text-primary">
						{{ t('showcase.mail.listTitle') }}
					</span>
					<span class="text-[8px] text-text-tertiary">
						{{ t('showcase.mail.unread', { count: 3 }) }}
					</span>
				</div>
				<div
					v-for="thread in threads"
					:key="thread.id"
					class="px-3 py-2 border-b border-border-subtle"
					:class="{ 'bg-(--surface-1-hover)': thread.selected }"
				>
					<div class="flex items-baseline justify-between gap-2">
						<span
							class="truncate text-[8.5px]"
							:class="thread.unread ? 'font-semibold text-text-primary' : 'text-text-secondary'"
						>
							{{ t(`showcase.mail.threads.${thread.id}.sender`) }}
						</span>
						<span class="text-[7.5px] text-text-tertiary shrink-0">
							{{ t(`showcase.mail.threads.${thread.id}.time`) }}
						</span>
					</div>
					<p
						class="truncate text-[8.5px] mt-px"
						:class="thread.unread ? 'font-medium text-text-primary' : 'text-text-secondary'"
					>
						{{ t(`showcase.mail.threads.${thread.id}.subject`) }}
					</p>
					<p class="truncate text-[7.5px] text-text-tertiary mt-px">
						{{ t(`showcase.mail.threads.${thread.id}.snippet`) }}
					</p>
				</div>
			</div>

			<!-- Pane 3: reader -->
			<div class="flex-1 min-w-0 bg-surface-3 flex flex-col max-md:hidden">
				<div class="flex items-center justify-end gap-1 px-3 py-1.5 border-b border-border-subtle">
					<span
						v-for="(icon, i) in [
							['m9 17-5-5 5-5', 'M20 18v-2a4 4 0 0 0-4-4H4'],
							['M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8', 'M2 3h20v5H2z', 'M10 12h4'],
							['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'],
						]"
						:key="i"
						class="p-1 rounded text-text-tertiary"
					>
						<svg
							width="9"
							height="9"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path v-for="(d, j) in icon" :key="j" :d="d" />
						</svg>
					</span>
				</div>
				<div class="px-4 py-3">
					<p class="text-[10px] font-semibold text-text-primary leading-snug">
						{{ t('showcase.mail.threads.mia.subject') }}
					</p>
					<div class="flex items-center gap-2 mt-2.5">
						<span
							class="w-5 h-5 rounded-full bg-brand-subtle text-brand text-[7px] font-semibold flex items-center justify-center"
						>
							{{ t('showcase.mail.reader.initials') }}
						</span>
						<div class="min-w-0">
							<p class="text-[8.5px] font-medium text-text-primary">
								{{ t('showcase.mail.threads.mia.sender') }}
							</p>
							<p class="text-[7.5px] text-text-tertiary">{{ t('showcase.mail.reader.meta') }}</p>
						</div>
					</div>
					<div class="mt-3 space-y-1.5 text-[8.5px] text-text-secondary leading-[1.6]">
						<p>{{ t('showcase.mail.reader.body1') }}</p>
						<p>{{ t('showcase.mail.reader.body2') }}</p>
						<p>{{ t('showcase.mail.reader.signature') }}</p>
					</div>
					<div class="flex items-center gap-1.5 mt-4">
						<span
							class="rounded-full bg-text-primary text-text-inverse text-[8px] font-medium px-3 py-1"
						>
							{{ t('showcase.mail.reader.reply') }}
						</span>
						<span
							class="rounded-full border border-border-default text-text-secondary text-[8px] font-medium px-3 py-1"
						>
							{{ t('showcase.mail.reader.forward') }}
						</span>
					</div>
				</div>
			</div>
		</div>
	</ShowcaseWindowFrame>
</template>
