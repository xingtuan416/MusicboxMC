import { describe, expect, it } from 'vitest';
import { allowedExternalUrl } from '../src/main/externalLink';

describe('external link allowlist', () => {
  it('allows the project repository and its pages', () => {
    expect(allowedExternalUrl('https://github.com/xingtuan416/MusicboxMC')).toBe(
      'https://github.com/xingtuan416/MusicboxMC',
    );
    expect(allowedExternalUrl('https://github.com/xingtuan416/MusicboxMC/issues')).toBe(
      'https://github.com/xingtuan416/MusicboxMC/issues',
    );
  });

  it('refuses other hosts, other repositories, plain http and non-URLs', () => {
    expect(allowedExternalUrl('https://example.com/xingtuan416/MusicboxMC')).toBeNull();
    expect(allowedExternalUrl('https://github.com/other/repo')).toBeNull();
    expect(allowedExternalUrl('https://github.com/xingtuan416/MusicboxMCevil')).toBeNull();
    expect(allowedExternalUrl('http://github.com/xingtuan416/MusicboxMC')).toBeNull();
    expect(allowedExternalUrl('file:///C:/Windows/System32/calc.exe')).toBeNull();
    expect(allowedExternalUrl('not a url')).toBeNull();
  });
});
