import { useState } from 'react';
import { coverageSentence } from '@core/links/pictures';
import { api, useAction, useApp, useResource } from '../../api/hooks';
import { Button } from '../../components/Button';
import { Segmented, Switch } from '../../components/Fields';
import { Glyph } from '../../components/Glyph';
import { ACCENTS, type Accent, type Appearance, type Density } from '../../lib/appearance';
import { readLinkPrefs, saveLinkPrefs, type LinkPrefs, type OpenLinksIn } from '../../lib/linkPrefs';
import { ICON_GUARD_SENTENCE, guardIcons, isLastIcon } from '../../lib/prefs';
import { words } from '../../lib/platform';
import { updatesHelp, versionLine } from '../../lib/updates';
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

/**
 * New versions (Nov 25, self-update): look for them, install them by themselves, the running version and the last look.
 * A copy that cannot update itself (built without the update key, or a development run) says so and keeps the old
 * behaviour: a message with a download link.
 */
function NewVersions() {
  const { settings, update } = usePrefs();
  const { state, refreshState } = useApp();
  const install = useAction(api.installUpdate);
  const updater = state?.updater;
  const looking = settings.updates?.tellMeAboutNewVersion ?? true;
  const automatic = settings.updates?.installAutomatically ?? true;
  const can = updater?.can ?? false;
  const line = versionLine(updater);
  return (
    <Row label="New versions" align="start" help={updatesHelp(updater)}>
      <div className="stack">
        <Switch label="Look for new versions" checked={looking} onChange={(tellMeAboutNewVersion) => update({ updates: { tellMeAboutNewVersion } })} />
        {can ? (
          <Switch
            label="Install new versions automatically"
            checked={automatic}
            disabled={!looking}
            onChange={(installAutomatically) => update({ updates: { installAutomatically } })}
          />
        ) : null}
        {line ? <p className="muted">{line}</p> : null}
        {can && looking && updater?.ready ? (
          <div>
            <Button size="sm" busy={install.busy} busyLabel="Installing…" onClick={() => void install.run(updater.ready!).then(() => refreshState())}>
              Install {updater.ready} now
            </Button>
            {install.error ? (
              <p className="frow-help" role="alert">
                {install.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Row>
  );
}

/**
 * Where a source page opens (docs/design.md, Desktop app > Page viewer), and whether product pictures show (each one is
 * a request to Amazon's image server). Kept in this computer's storage, as the look is; every window follows at once.
 */
function LinksAndPictures() {
  const [prefs, setPrefs] = useState(readLinkPrefs);
  // Nov 25: how far pictures reach on the stored deals, so he sees it fill in after a scan ("Pictures for 212 of 258 deals").
  const [deals] = useResource(() => api.deals(), [], ['deals']);
  const coverage = deals.data?.pictures ? coverageSentence(deals.data.pictures) : null;
  const change = (patch: Partial<LinkPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveLinkPrefs(next);
  };
  return (
    <>
      <Rule />
      <Row
        label="Open links"
        align="start"
        help="Home Depot, Amazon, Keepa and eBay pages open in Split Finder’s own window, where you are not signed in. Sign-in pages, accounts and downloads always open in your browser."
      >
        <Segmented<OpenLinksIn>
          legend="Open links"
          value={prefs.openLinksIn}
          onChange={(openLinksIn) => change({ openLinksIn })}
          options={[
            { value: 'app', label: 'In Split Finder' },
            { value: 'browser', label: 'In my browser' },
          ]}
        />
      </Row>
      <Row
        label="Pictures"
        help={`The Home Depot photo stored for a deal, and the Amazon or Home Depot photo stored for each part. Each picture is loaded from Home Depot’s or Amazon’s image server.${coverage ? ` ${coverage}` : ''}`}
      >
        <Switch label="Show product pictures" checked={prefs.showPictures} onChange={(showPictures) => change({ showPictures })} />
      </Row>
    </>
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
      <Row label="Startup" align="start" help={`Split Finder keeps running in the ${words.trayPlace} when its window is closed.`}>
        <div className="stack">
          <Switch label="Open at login" checked={shell.launchAtLogin} onChange={(launchAtLogin) => update({ shell: { launchAtLogin } })} />
        </div>
      </Row>
      <Row label="Icons" align="start" help={refused || isLastIcon(shell, 'menuBarIcon') || isLastIcon(shell, 'dockIcon') ? ICON_GUARD_SENTENCE : undefined}>
        <div className="stack">
          <Switch label={words.trayIconSwitch} checked={shell.menuBarIcon} disabled={isLastIcon(shell, 'menuBarIcon')} onChange={(on) => flip('menuBarIcon', on)} />
          <Switch label={words.dockSwitch} checked={shell.dockIcon} disabled={isLastIcon(shell, 'dockIcon')} onChange={(on) => flip('dockIcon', on)} />
        </div>
      </Row>
      {/* page viewer and pictures begin (Nov 25): two preferences of this computer, kept with the look. */}
      <LinksAndPictures />
      {/* page viewer and pictures end */}
      <Rule />
      <NewVersions />
      <Rule />
      <Row label="Sounds" help="Notifications from Split Finder play the default sound.">
        <Switch label="Play a sound with notifications" checked={settings.notifications.sound} onChange={(sound) => update({ notifications: { sound } })} />
      </Row>
    </Pane>
  );
}
