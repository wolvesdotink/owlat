/**
 * Whether the email's text carries a postal address, which CAN-SPAM requires
 * in commercial email (and many EU imprint rules expect).
 *
 * A heuristic over the visible text: a street line, a postcode next to a town,
 * a US state and ZIP, a UK postcode, or a PO box. It misses an address written
 * in an image and can be fooled by a lucky number, which is why its finding is
 * a warning and its copy says "we could not find" rather than "missing".
 */

const PATTERNS: readonly RegExp[] = [
	// 12 Main Street, 500 Fifth Ave, 1 Infinite Loop. Capitalised, because "5
	// friends on the way" is not an address.
	/\b\d{1,5}[a-z]?\s+(?:\p{Lu}[\p{L}'.-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Square|Sq|Parkway|Pkwy|Highway|Hwy|Loop)\b/u,
	// Hauptstraße 5, Feldweg 12a
	/(?:straße|strasse|str\.|weg|platz|allee|gasse|chaussee)\s+\d{1,4}[a-z]?\b/iu,
	// 12 rue de Rivoli, 3 bis avenue Foch
	/\b\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|boulevard|bd|allée|chemin|impasse|quai)\s+\p{L}/iu,
	// 10115 Berlin, 75001 Paris, 1010 Wien, CH-8001 Zürich (a four-digit
	// number that reads as a year, as in "© 2026 Acme", is not a postcode)
	/\b(?:[A-Z]{1,2}-)?(?:\d{5}|(?!19|20)\d{4})\s+\p{Lu}\p{Ll}{2,}/u,
	// Springfield, IL 62701
	/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/,
	// SW1A 1AA, EC1V 9HX
	/\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/,
	/\b(?:p\.?\s?o\.?\s?box|postfach|apartado|boîte postale)\b/iu,
];

export function hasPostalAddress(text: string): boolean {
	return PATTERNS.some((pattern) => pattern.test(text));
}
