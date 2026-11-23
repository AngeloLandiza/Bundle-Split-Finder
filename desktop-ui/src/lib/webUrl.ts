// Every link the app shows or opens goes through here (security review, Nov 23). The address comes from stored data:
// a Home Depot page the helper read, an eBay listing, a link the owner typed. Only a web address (http or https, no
// user or password in it) is a link; anything else (javascript:, data:, file:, a Windows share) is shown as text.

/** The address as the URL parser writes it, or null when it is not a web address to open. */
export function webUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username !== '' || u.password !== '' || u.hostname === '') return null;
    return u.href;
  } catch {
    return null;
  }
}
