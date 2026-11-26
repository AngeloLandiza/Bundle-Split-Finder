// Product pictures (docs/design.md, Desktop app > Product pictures). A stored picture address is untrusted data: it is
// shown only when it is https on one of the image hosts the stored records actually hold, which the app's content
// security policy names one by one (src-tauri/tauri.conf.json and agent/uiStatic.ts UI_CSP). Nothing here fetches or
// guesses a picture; a part with none has none.

// PICTURE_HOSTS begin (the CSP's img-src names exactly these; core/test/pictures.test.ts checks both)
export const PICTURE_HOSTS: readonly string[] = ['m.media-amazon.com'];
// PICTURE_HOSTS end

/** The address to load, or null when there is no picture to show. */
export function pictureUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
    if (!PICTURE_HOSTS.includes(u.hostname.toLowerCase())) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** The picture a deal row shows: its first part's stored listing picture, when that part has one. */
export function rowPicture(parts: readonly { image: string | null }[]): string | null {
  return pictureUrl(parts[0]?.image ?? null);
}
