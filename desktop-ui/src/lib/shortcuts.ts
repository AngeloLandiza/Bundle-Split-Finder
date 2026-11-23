// Every shortcut the app answers to, by area, for the shortcuts sheet (Cmd+/). The keys themselves are decided in
// keys.ts; this is the list a person reads. A key added there is added here, or the sheet is wrong.

import { wordsFor } from './platform';

export interface Shortcut {
  /** What it does, as a short phrase. */
  does: string;
  /** The keys, one cap each: ['⌘', 'K']. */
  keys: string[];
  /** Another way to the same thing ("or ↓"), shown after the keys. */
  or?: string[];
}

export interface ShortcutArea {
  title: string;
  items: Shortcut[];
}

/** Cmd on a Mac, Ctrl elsewhere, option as ⌥ or Alt, shift as ⇧ or Shift. */
export function caps(mac: boolean) {
  return { mod: mac ? '⌘' : 'Ctrl', alt: mac ? '⌥' : 'Alt', shift: mac ? '⇧' : 'Shift', enter: mac ? '↩' : 'Enter' };
}

export function shortcutAreas(mac: boolean, windows = !mac): ShortcutArea[] {
  const { mod, alt, shift, enter } = caps(mac);
  return [
    {
      title: 'Anywhere',
      items: [
        { does: 'Command palette', keys: [mod, 'K'] },
        { does: 'Keyboard shortcuts', keys: [mod, '/'] },
        { does: 'Search this screen', keys: [mod, 'F'] },
        { does: 'Show or hide the inspector', keys: [mod, alt, 'I'] },
        { does: 'Go to Today', keys: [mod, '1'] },
        { does: 'Go to Deals', keys: [mod, '2'] },
        { does: 'Go to Review', keys: [mod, '3'] },
        { does: 'Go to Activity', keys: [mod, '4'] },
        { does: `Open ${wordsFor(windows).preferences}`, keys: [mod, ','], or: [mod, '5'] },
        { does: 'Scan now', keys: [mod, 'R'] },
        ...(windows ? [{ does: 'Refresh the deals and questions', keys: ['F5'] }] : []),
      ],
    },
    {
      title: 'Command palette',
      items: [
        { does: 'Move through the results', keys: ['↑'], or: ['↓'] },
        { does: 'Run the chosen result', keys: [enter] },
        { does: 'Close the palette, or go back', keys: ['Esc'] },
      ],
    },
    {
      title: 'Deals and Review lists',
      items: [
        { does: 'Next row', keys: ['J'], or: ['↓'] },
        { does: 'Previous row', keys: ['K'], or: ['↑'] },
        { does: 'Open the row', keys: [enter] },
        { does: 'Close the inspector selection', keys: ['Esc'] },
        { does: 'Open the row’s menu', keys: [shift, 'F10'], or: ['Menu key'] },
      ],
    },
    {
      title: 'Review',
      items: [
        { does: 'Choose an answer', keys: ['1'], or: ['9'] },
        { does: 'Save the answer, or approve the AI’s', keys: [enter] },
        { does: 'Ask AI about the question', keys: ['A'] },
        { does: 'Undo the answer just saved', keys: [mod, 'Z'] },
      ],
    },
    {
      title: 'Menus and sheets',
      items: [
        { does: 'Move through a menu', keys: ['↑'], or: ['↓'] },
        { does: 'Choose the item', keys: [enter] },
        { does: 'Close a menu or a sheet', keys: ['Esc'] },
        { does: 'Open a part’s menu in the inspector', keys: [shift, 'F10'], or: ['Menu key'] },
      ],
    },
  ];
}
