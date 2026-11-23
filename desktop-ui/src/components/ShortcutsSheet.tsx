import { formatShortcut, isMac as mac, isWindows } from '../lib/platform';
import { shortcutAreas } from '../lib/shortcuts';
import { Button } from './Button';
import { Kbd } from './Layout';
import { Sheet, SheetActions } from './Sheet';
import './ShortcutsSheet.css';


/** Every shortcut, by area (Cmd+/ or Help > Keyboard shortcuts). A sheet over the live window; Escape closes it. */
export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const areas = shortcutAreas(mac, isWindows);
  return (
    <Sheet
      label="Keyboard shortcuts"
      width={620}
      onCancel={onClose}
      footer={
        <SheetActions
          lead={<span className="shortcuts-foot">Press {formatShortcut(['mod', '/'], mac)} again to close.</span>}
          primary={
            <Button variant="primary" onClick={onClose} data-autofocus="">
              Done
            </Button>
          }
        />
      }
    >
      <h2 className="shortcuts-title">Keyboard shortcuts</h2>
      <div className="shortcuts-grid">
        {areas.map((area) => (
          <section key={area.title} className="shortcuts-area" aria-labelledby={`sc-${area.title}`}>
            <h3 className="shortcuts-head" id={`sc-${area.title}`}>
              {area.title}
            </h3>
            <dl className="shortcuts-list">
              {area.items.map((item) => (
                <div key={item.does} className="shortcut">
                  <dt>{item.does}</dt>
                  <dd>
                    <span className="shortcut-keys">
                      {item.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                    {item.or ? (
                      <>
                        <span className="shortcut-or">or</span>
                        <span className="shortcut-keys">
                          {item.or.map((k) => (
                            <Kbd key={k}>{k}</Kbd>
                          ))}
                        </span>
                      </>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
