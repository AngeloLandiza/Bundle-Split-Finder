// The updater's public key in src-tauri/tauri.conf.json (plugins.updater.pubkey). `npm run updater:setup` writes it there;
// the build checks the signing key against it and the app verifies every update with it (tauri-plugin-updater: the config
// value must be the key's content, not a path). Empty: this build cannot update itself, and says so in Settings. Pure.

const PUBKEY_LINE = /("pubkey": ")([^"]*)(")/g;

/** Whether the text is a minisign public key as `tauri signer generate` writes the .pub file: one base64 line. */
export function isMinisignPublicKey(b64: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length > 400) return false;
  let text: string;
  try {
    text = atob(b64);
  } catch {
    return false;
  }
  const [comment, body] = text.split('\n');
  return comment?.startsWith('untrusted comment: minisign public key') === true && /^RW[A-Za-z0-9+/]{54}$/.test(body ?? '');
}

/** The public key the config names, or '' when none is set. */
export function pubkeyOf(confText: string): string {
  try {
    const c = JSON.parse(confText) as { plugins?: { updater?: { pubkey?: unknown } } };
    return typeof c.plugins?.updater?.pubkey === 'string' ? c.plugins.updater.pubkey : '';
  } catch {
    return '';
  }
}

/** The config with `pubkey` in plugins.updater, changing only that value; or why it cannot be. */
export function setPubkey(confText: string, pubkey: string): { ok: true; text: string } | { ok: false; problem: string } {
  const key = pubkey.trim();
  if (!isMinisignPublicKey(key)) return { ok: false, problem: 'the .pub file is not a minisign public key made by tauri signer generate.' };
  const found = [...confText.matchAll(PUBKEY_LINE)].length;
  if (found !== 1) return { ok: false, problem: `src-tauri/tauri.conf.json must have one "pubkey" line under plugins.updater (found ${found}).` };
  const text = confText.replace(PUBKEY_LINE, (_m, before: string, _old: string, after: string) => `${before}${key}${after}`);
  if (pubkeyOf(text) !== key) return { ok: false, problem: 'the "pubkey" line is not plugins.updater.pubkey.' };
  return { ok: true, text };
}
