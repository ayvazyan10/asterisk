// How `asterisk update` decides what kind of install it is looking at.
//
// The distinction is not cosmetic. The git path's failure message told an
// npm-installed user to "run install.sh first", which would have installed a
// second copy over a working one — the worst possible advice, delivered
// confidently.

import { describe, expect, it } from 'vitest';

import { installKind } from '../src/entrypoints/update.ts';

describe('installKind', () => {
  it('reads a global npm install as npm', () => {
    expect(installKind('/usr/lib/node_modules/@ayvazyan101/asterisk/dist')).toBe('npm');
  });

  it('reads an npm install under a custom prefix as npm', () => {
    expect(installKind('/home/me/.npm-global/lib/node_modules/@ayvazyan101/asterisk/dist')).toBe(
      'npm',
    );
  });

  it('reads an install.sh clone as git', () => {
    expect(installKind('/home/me/.local/share/asterisk/dist')).toBe('git');
  });

  it('reads a source checkout as git', () => {
    expect(installKind('/home/me/projects/asterisk/src/entrypoints')).toBe('git');
  });

  it('does not mistake a directory merely named node_modules-something', () => {
    // Substring matching without the separators would call this npm.
    expect(installKind('/home/me/node_modules_backup/asterisk/dist')).toBe('git');
  });
});
