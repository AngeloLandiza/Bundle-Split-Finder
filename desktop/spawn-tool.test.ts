import { describe, expect, it } from 'vitest';

import { cmdQuote, toolInvocation } from '../scripts/spawn-tool';

describe('toolInvocation', () => {
  it('spawns the tool directly off Windows', () => {
    expect(toolInvocation('npx', ['wxt', 'zip'], 'darwin')).toEqual({ file: 'npx', args: ['wxt', 'zip'], shell: false });
  });

  it('on Windows runs the .cmd shim through one quoted command line', () => {
    expect(toolInvocation('npx', ['--yes', 'postject', 'C:\\Program Files\\x\\a.exe'], 'win32')).toEqual({
      file: 'npx.cmd --yes postject "C:\\Program Files\\x\\a.exe"', args: [], shell: true,
    });
  });

  it('refuses what cmd.exe would expand', () => {
    expect(() => cmdQuote('50%')).toThrow();
    expect(() => cmdQuote('a"b')).toThrow();
  });
});
