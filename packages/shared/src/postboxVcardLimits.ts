/**
 * The bounds of a vCard import into the Postbox address book. Their own module
 * so the contacts page can show them without loading the parser, which it
 * imports only when an import or export starts.
 */

/** Largest .vcf file the contacts page reads. */
export const VCARD_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Cards read from one file; the rest of the file is not looked at. */
export const VCARD_MAX_CARDS = 5_000;
/** Address-book entries one import writes. */
export const VCARD_MAX_ENTRIES = 2_000;
/** Entries per import mutation call. */
export const VCARD_IMPORT_BATCH_SIZE = 100;
export const VCARD_MAX_EMAILS_PER_CARD = 10;
export const VCARD_MAX_PHONES = 10;
export const VCARD_MAX_ADDRESSES = 3;
