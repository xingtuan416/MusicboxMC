/**
 * The only external URL the renderer may hand to the shell.
 *
 * The About section links to this repository; the preload exposes `open()` to the
 * renderer, so a compromised renderer must not be able to launch arbitrary pages in
 * the user's browser. Keep this an allowlist, not a scheme check.
 */
const REPOSITORY_PREFIX = '/xingtuan416/MusicboxMC';

export function allowedExternalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  if (!url.pathname.startsWith(REPOSITORY_PREFIX)) return null;
  return url.toString();
}
