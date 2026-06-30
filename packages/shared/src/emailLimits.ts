/**
 * Well-known email-client platform limits — the single source of truth shared by
 * the email-renderer's size analyzer and the email-previewer's Size tab. (The
 * previewer avoids depending on the heavy email-renderer package but can take
 * these constants from @owlat/shared.)
 */

/** Gmail clips the message ("view entire message" link) above ~102 KB of HTML. */
export const GMAIL_CLIP_BYTES = 102 * 1024;

/** Gmail strips a `<style>` block larger than ~8 KB. */
export const GMAIL_CSS_LIMIT_BYTES = 8192;

/** 75% early-warning threshold for the Gmail CSS limit. */
export const GMAIL_CSS_WARNING_BYTES = 6144;
