import {
	POSTBOX_THREAD_COMMAND_PROVIDER_ID_PREFIX,
	POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY,
	buildThreadSurfaceGroups,
} from '~/lib/commandPaletteSurfaces';
import { matchPostboxRoute } from '~/composables/postbox/usePostboxCommandSurface';

/** What the open conversation hands the palette. */
export interface PostboxThreadCommandSources {
	/** Subject of the open message, for the row's muted context line. */
	subject: () => string;
	/** Archive the open conversation (the reader's own triage path). */
	onArchive: () => void;
	/** Reply to the open conversation (the reader's own reply path). */
	onReply: () => void;
}

/**
 * Registers the OPEN CONVERSATION as a palette provider for as long as the
 * reader is mounted.
 *
 * The Postbox layout's provider covers the mailbox: switching folders, the
 * actions demoted into the overflow menu, the labels. Archive and Reply — the
 * two verbs the reader leads with — were reachable only by key or by button, so
 * ⌘K on an open thread could not do the two things you are most likely there to
 * do.
 *
 * The verbs run the reader's own actions directly rather than the window-event
 * bridge the mailbox provider uses: this composable is called from inside the
 * reader, so it can act on THIS conversation instead of broadcasting to every
 * mounted one. That is also why each instance claims its own provider id — the
 * folder reader and the Today overlay can be mounted at the same time, and a
 * shared id would let the survivor of that pair be the instance whose
 * registration was refused. The shared group key collapses the pair to one
 * block; when both are up, the first-mounted reader is the one that answers.
 */
export function usePostboxThreadCommandSurface(sources: PostboxThreadCommandSources): void {
	const { t } = useI18n();
	const instanceId = useId();

	registerCommandPaletteProvider({
		id: `${POSTBOX_THREAD_COMMAND_PROVIDER_ID_PREFIX}:${instanceId}`,
		priority: POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY,
		matchRoute: matchPostboxRoute,
		build: ({ query }) =>
			buildThreadSurfaceGroups(
				{
					subject: sources.subject,
					t,
					onArchive: sources.onArchive,
					onReply: sources.onReply,
				},
				query
			),
	});
}
