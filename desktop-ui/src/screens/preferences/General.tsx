import { useState } from 'react';
import { Segmented, Switch } from '../../components/Fields';
import { Glyph } from '../../components/Glyph';
import { ACCENTS, type Accent, type Appearance, type Density } from '../../lib/appearance';
import { ICON_GUARD_SENTENCE, guardIcons, isLastIcon } from '../../lib/prefs';
import { Pane, Row, Rule, usePrefs } from './form';

const ACCENT_NAME: Record<Accent, string> = {
  system: 'System',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  graphite: 'Graphite',
};

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** A window drawn small, in the colours of one scheme: a sidebar, a title line and rows. */
function Mini({ scheme }: { scheme: 'light' | 'dark' }) {
  return (
    <span className={`mini mini-${scheme}`} aria-hidden="true">
      <span className="mini-side" />
      <span className="mini-body">
        <span className="mini-line mini-line-title" />
        <span className="mini-line" />
        <span className="mini-line" />
        <span className="mini-line mini-line-short" />
      </span>
    </span>
  );
}

export function GeneralPane() {
  const { settings, update, look, setLook } = usePrefs();
  const [refused, setRefused] = useState(false);
  const shell = settings.shell;
  const flip = (key: 'menuBarIcon' | 'dockIcon', on: boolean) => {
    const patch = key === 'menuBarIcon' ? { menuBarIcon: on } : { dockIcon: on };
    const { blocked } = guardIcons(shell, patch);
    setRefused(blocked !== null);
    if (blocked === null) update({ shell: patch });
  };
  return (
    <Pane>
      <Row label="Appearance" align="start">
        <fieldset className="looks">
          <legend className="sr-only">Appearance</legend>
          {APPEARANCES.map((a) => (
            <label key={a.value} className={`look${look.appearance === a.value ? ' look-on' : ''}`}>
              <input type="radio" name="appearance" value={a.value} checked={look.appearance === a.value} onChange={() => setLook({ ...look, appearance: a.value })} />
              <span className="look-thumb">
                {a.value === 'system' ? (
                  <>
                    <Mini scheme="light" />
                    <span className="mini-dark-half">
                      <Mini scheme="dark" />
                    </span>
                  </>
                ) : (
                  <Mini scheme={a.value} />
                )}
              </span>
              <span className="look-name">{a.label}</span>
            </label>
          ))}
        </fieldset>
      </Row>
      <Row label="Accent colour" align="start" help={ACCENT_NAME[look.accent]}>
        <fieldset className="swatches swatches-large">
          <legend className="sr-only">Accent colour</legend>
          {ACCENTS.map((a) => (
            <label key={a} className={`swatch swatch-${a}`} title={ACCENT_NAME[a]}>
              <input type="radio" name="accent" value={a} checked={look.accent === a} onChange={() => setLook({ ...look, accent: a })} />
              <span className="sr-only">{ACCENT_NAME[a]}</span>
              {look.accent === a ? <Glyph name="check" size={11} className="swatch-check" /> : null}
            </label>
          ))}
        </fieldset>
      </Row>
      <Row label="Density">
        <Segmented<Density>
          legend="Density"
          value={look.density}
          onChange={(density) => setLook({ ...look, density })}
          options={[
            { value: 'regular', label: 'Regular' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
      </Row>
      <Rule />
      <Row label="Startup" align="start" help="Split Finder keeps running in the menu bar when its window is closed.">
        <div className="stack">
          <Switch label="Open at login" checked={shell.launchAtLogin} onChange={(launchAtLogin) => update({ shell: { launchAtLogin } })} />
        </div>
      </Row>
      <Row label="Icons" align="start" help={refused || isLastIcon(shell, 'menuBarIcon') || isLastIcon(shell, 'dockIcon') ? ICON_GUARD_SENTENCE : undefined}>
        <div className="stack">
          <Switch label="Show menu bar icon" checked={shell.menuBarIcon} disabled={isLastIcon(shell, 'menuBarIcon')} onChange={(on) => flip('menuBarIcon', on)} />
          <Switch label="Show Dock icon" checked={shell.dockIcon} disabled={isLastIcon(shell, 'dockIcon')} onChange={(on) => flip('dockIcon', on)} />
        </div>
      </Row>
      <Rule />
      <Row label="Sounds" help="Notifications from Split Finder play the default sound.">
        <Switch label="Play a sound with notifications" checked={settings.notifications.sound} onChange={(sound) => update({ notifications: { sound } })} />
      </Row>
    </Pane>
  );
}
