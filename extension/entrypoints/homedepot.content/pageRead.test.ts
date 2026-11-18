// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { itemIdOf, stateTextOf } from './pageRead';
import { pricedText } from './realViews';

describe('itemIdOf', () => {
  it('reads the item id from a Home Depot product path and from the replay server\'s', () => {
    expect(itemIdOf('/p/RYOBI-ONE-HP-18V-Brushless-Cordless-Extended-Reach-Ratchets-Tools-Only-PBLRC2501SB/328814689')).toBe('328814689');
    expect(itemIdOf('/p/328814689')).toBe('328814689');
    expect(itemIdOf('/p/Some-Title/328814689/')).toBe('328814689');
  });

  it('is null for anything else', () => {
    for (const path of ['/', '/b/Tools/N-5yc1v', '/p/Some-Title', '/p/Some-Title/not-a-number', '/s/ryobi', '/p/12345']) expect(itemIdOf(path), path).toBeNull();
  });
});

describe('stateTextOf', () => {
  it('returns the inline script that holds the page state, as the recorded page has it', () => {
    document.body.innerHTML = '<script>var a = 1;</script><script src="https://www.homedepot.com/x.js"></script>';
    const script = document.createElement('script');
    script.type = 'text/plain';
    script.textContent = pricedText('328814689');
    document.body.append(script);
    expect(stateTextOf(document)).toBe(pricedText('328814689'));
  });

  it('is null when no inline script has it', () => {
    document.body.innerHTML = '<script>var a = 1;</script>';
    expect(stateTextOf(document)).toBeNull();
  });
});
