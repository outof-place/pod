// Fork-only (Pod): a downstream product renames upstream's UI copy when it loads, so the six
// locale catalogs stay byte-identical to upstream and every upstream string change merges cleanly.

export type ProductNameBranding = {
  displayName: string
  cliName: string
}

// Copy that names upstream on purpose: Stably's own services (hidden in a product without them)
// and credit or support for Orca.
const UPSTREAM_PHRASES = [
  String.raw`(?:\b[Aa]n )?\bOrca(?:'s|’s)? (?:Cloud|Relay|relay|Mobile|mobile|account|Account|iOS|Android)\b`,
  String.raw`\b(?:Star|star|Support|support|Built on|built on|Based on|based on) Orca\b`,
  String.raw`\bOrca by Stably\b`
]

// Lowercase `orca` is the shell command only when quoted or followed by a subcommand; the lookbehind
// keeps paths, packages and handles (`~/.orca`, `acme/orca-notes`, `@orca`) intact.
const PRODUCT_NAME_PATTERN = new RegExp(
  [
    `(${UPSTREAM_PHRASES.join('|')})`,
    String.raw`\b([Aa])n Orca\b`,
    String.raw`\bOrca\b`,
    String.raw`\bORCA\b`,
    String.raw`(?<![\w./@~-])orca(?=\x60| (?:[a-z][a-z-]*|CLI)\b)`
  ].join('|'),
  'g'
)

/** Upstream phrases that stay "Orca" after branding; tests use this as their allowlist. */
export const UPSTREAM_PRODUCT_PHRASE = new RegExp(UPSTREAM_PHRASES.join('|'), 'g')

export function brandProductName(text: string, branding: ProductNameBranding): string {
  if (!text.includes('Orca') && !text.includes('ORCA') && !text.includes('orca')) {
    return text
  }
  const article = /^[aeiou]/i.test(branding.displayName) ? 'an' : 'a'
  return text.replace(
    PRODUCT_NAME_PATTERN,
    (match: string, kept: string | undefined, articleCase: string | undefined) => {
      if (kept) {
        return kept
      }
      if (articleCase) {
        const brandedArticle = articleCase === 'A' ? `A${article.slice(1)}` : article
        return `${brandedArticle} ${branding.displayName}`
      }
      if (match === 'ORCA') {
        return branding.displayName.toUpperCase()
      }
      return match === 'orca' ? branding.cliName : branding.displayName
    }
  )
}

/** Brands every string leaf of a nested i18next catalog; returns a new object. */
export function brandProductCatalog(
  catalog: Record<string, unknown>,
  branding: ProductNameBranding
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, entry]) => [key, brandValue(entry, branding)])
  )
}

function brandValue(value: unknown, branding: ProductNameBranding): unknown {
  if (typeof value === 'string') {
    return brandProductName(value, branding)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => brandValue(entry, branding))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, brandValue(entry, branding)])
    )
  }
  return value
}
