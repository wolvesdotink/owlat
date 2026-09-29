import type { OptimisticUpdate } from 'convex/browser';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';

/**
 * Native optimistic update for `mail.settings.update`: the cached settings row
 * takes the new values the moment a preference is switched, so the reading
 * preferences, the density and view toggles and the layout that reads them all
 * repaint in the same frame. A user who never saved a row reads `null`; the
 * patch starts one from the values being written, which is what the server's
 * insert will hold.
 */
type Settings = NonNullable<FunctionReturnType<typeof api.mail.settings.get>>;

export const optimisticUpdateSettings: OptimisticUpdate<
	FunctionArgs<typeof api.mail.settings.update>
> = (store, args) => {
	const current = store.getQuery(api.mail.settings.get, {});
	// Still loading: nothing on screen reads a value to patch.
	if (current === undefined) return;
	const written = Object.fromEntries(
		Object.entries(args).filter(([, value]) => value !== undefined)
	) as Partial<Settings>;
	if (Object.keys(written).length === 0) return;
	store.setQuery(api.mail.settings.get, {}, { ...current, ...written } as Settings);
};
