/**
 * The pre-send checks for one rendered email, as reactive state: the checks
 * the browser runs on the HTML and Blocks (instantly, on every change of the
 * source) and the server round trip for links, images and the MTA's content
 * screening (`emailTemplates.presendChecksActions.run`), which runs when
 * `run()` is called and again whenever the HTML changes after that.
 *
 * Shared by the campaign Review step (which runs it on arrival) and the email
 * editor's "Check email" (which runs it on demand, on the unsaved canvas).
 * A newer run always wins over an older one still in flight.
 */
import { api } from '@owlat/api';
import { DEFAULT_EMAIL_THEME } from '@owlat/shared/emailDefaults';
import type { EditorBlock } from '@owlat/shared';
import { buildPresendChecks, scanForPresend, summarizePresend } from '~/lib/presendChecks/checks';
import type { PresendRemote } from '~/lib/presendChecks/remote';
import type { PresendCheck } from '~/lib/presendChecks/types';

export interface PresendSource {
	html: string;
	blocks: EditorBlock[];
	subject: string;
	/** The From address the send would use, for the content screening. */
	fromEmail?: string;
	audienceKind?: 'topic' | 'segment';
	blockedReason?: string | null;
}

/**
 * The longest string any public Convex function takes (`lib/publicInput.ts` in
 * the API). A longer HTML would fail the whole round trip, so it is not sent
 * for screening; the links and images are still probed.
 */
const SCREENABLE_HTML_CHARS = 1024 * 1024;

export function usePresendChecks(source: () => PresendSource | null) {
	// The organization theme the email was rendered with: the contrast checks
	// read its colours, dark-mode ones included.
	const { emailTheme } = useEmailTheme();
	const remote = shallowRef<PresendRemote>({ status: 'pending' });
	/** The HTML the last `run()` was asked for; `null` until the first run. */
	const ranFor = ref<string | null>(null);
	let sequence = 0;

	const scan = computed(() => {
		const current = source();
		return current ? scanForPresend(current.html) : null;
	});

	async function run(): Promise<void> {
		const current = source();
		const scanned = scan.value;
		if (!current || !scanned) return;
		const seq = ++sequence;
		ranFor.value = current.html;
		remote.value = { status: 'pending' };
		const convex = useConvex();
		if (!convex) {
			remote.value = { status: 'failed' };
			return;
		}
		const screenable = current.html.length <= SCREENABLE_HTML_CHARS;
		try {
			const result = await convex.action(api.emailTemplates.presendChecksActions.run, {
				links: [...scanned.links.probes.keys()],
				images: scanned.images,
				...(screenable
					? {
							screening: {
								subject: current.subject,
								html: current.html,
								...(current.fromEmail ? { fromEmail: current.fromEmail } : {}),
							},
						}
					: {}),
			});
			if (seq !== sequence) return;
			remote.value = {
				status: 'done',
				result: screenable ? result : { ...result, screening: { status: 'too_large' } },
			};
		} catch {
			if (seq === sequence) remote.value = { status: 'failed' };
		}
	}

	// Once checked, a new version of the email (a save landing, a re-render) is
	// checked again rather than judged against the old answers.
	watch(
		() => source()?.html,
		(html) => {
			if (ranFor.value !== null && html !== undefined && html !== ranFor.value) void run();
		}
	);

	const checks = computed<PresendCheck[]>(() => {
		const current = source();
		if (!current || !scan.value) return [];
		return buildPresendChecks(
			{
				blocks: current.blocks,
				subject: current.subject,
				theme: { ...DEFAULT_EMAIL_THEME, ...emailTheme.value },
				...(current.audienceKind ? { audienceKind: current.audienceKind } : {}),
				...(current.blockedReason !== undefined ? { blockedReason: current.blockedReason } : {}),
				remote: remote.value,
			},
			scan.value
		);
	});

	const summary = computed(() => summarizePresend(checks.value));
	const isChecking = computed(() => remote.value.status === 'pending' && ranFor.value !== null);

	return { checks, summary, isChecking, run };
}
