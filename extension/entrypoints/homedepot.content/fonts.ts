// The chip's fonts. @font-face does not load inside a shadow root, so the rules go in the page's own document,
// pointing at the extension's bundled files (public/fonts, the same ones the panel uses), which wxt.config.ts makes
// web-accessible to Home Depot pages only. The families are named for the extension so a page that has its own
// "Barlow" is not changed by them.

export const FONT_STYLE_ID = 'split-finder-chip-fonts';

const FACES = [
  { family: 'Split Finder Barlow', weight: 400, file: 'barlow-400.woff2' },
  { family: 'Split Finder Barlow', weight: 500, file: 'barlow-500.woff2' },
  { family: 'Split Finder Barlow', weight: 600, file: 'barlow-600.woff2' },
  { family: 'Split Finder JetBrains Mono', weight: 400, file: 'jetbrains-mono-400.woff2' },
  { family: 'Split Finder JetBrains Mono', weight: 500, file: 'jetbrains-mono-500.woff2' },
  { family: 'Split Finder JetBrains Mono', weight: 600, file: 'jetbrains-mono-600.woff2' },
] as const;

/** The @font-face rules, with each file's address from `urlOf` (runtime.getURL). */
export function fontFaceCss(urlOf: (path: string) => string): string {
  return FACES.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url('${urlOf(`/fonts/${f.file}`)}') format('woff2')}`,
  ).join('\n');
}

/** Adds the rules to the document once. Without a head or body to put them in, does nothing (the system fonts show). */
export function ensureFonts(doc: Document, urlOf: (path: string) => string): void {
  if (doc.getElementById(FONT_STYLE_ID)) return;
  const parent = doc.head ?? doc.body;
  if (!parent) return;
  const style = doc.createElement('style');
  style.id = FONT_STYLE_ID;
  style.textContent = fontFaceCss(urlOf);
  parent.append(style);
}
