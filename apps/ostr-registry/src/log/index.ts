/**
 * The embedded transparency log: an append-only Merkle tree over SQLite behind
 * the frozen `RegistryLog` contract (plan §9.1, D1; spec 05).
 *
 * `LogStore` is exported for operators and tools that need the raw rows
 * (backups, offline verification); the log itself is the supported surface.
 * A log has exactly one writer, and `acquireWriterLock` is what enforces it.
 */
export {
	DEFAULT_MMD_SECONDS,
	MAX_ENTRIES_PAGE,
	SqliteRegistryLog,
	type SqliteRegistryLogOptions,
} from './sqliteLog.js';
export {
	LogStore,
	SCHEMA_VERSION,
	type EntryInsert,
	type StoredEntry,
	type StoredHead,
} from './store.js';
export { acquireWriterLock, type WriterLock } from './writerLock.js';
