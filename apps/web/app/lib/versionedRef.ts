import { customRef, reactive, ref, toRaw, type Ref } from 'vue';

export interface VersionedRef<T> {
	/** A deep ref, like `ref(initial)`. */
	ref: Ref<T>;
	/** Goes up on every write to `ref`, including a write of the value it holds. */
	version: Readonly<Ref<number>>;
}

/**
 * A deep ref that counts its writes.
 *
 * The email canvas emits `update:blocks` once per change, handing back the same
 * array it edited in place. A plain `ref` ignores that write (nothing new to
 * hold), so the only way to notice the change was to deep-watch the whole block
 * tree. Here the write still bumps `version`, which the dirty tracker watches
 * instead. Readers of the ref itself are only notified when the value really
 * changes, as with `ref`.
 */
export function versionedRef<T>(initial: T): VersionedRef<T> {
	const version = ref(0);
	const wrap = (value: T): T =>
		value !== null && typeof value === 'object' ? (reactive(value) as T) : value;
	let current = wrap(initial);
	const value = customRef<T>((track, trigger) => ({
		get() {
			track();
			return current;
		},
		set(next) {
			version.value++;
			if (toRaw(next) === toRaw(current)) return;
			current = wrap(next);
			trigger();
		},
	}));
	return { ref: value, version };
}
