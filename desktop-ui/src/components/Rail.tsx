import type { ReactNode } from 'react';
import type { Screen } from '../lib/keys';
import { modLabel } from '../lib/keys';
import { Count } from './Tag';
import './Rail.css';

const MARK = (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M10 2.75h4.75a2.5 2.5 0 0 1 2.5 2.5v9.5a2.5 2.5 0 0 1-2.5 2.5H10z" fill="currentColor" />
  </svg>
);

export interface RailItem {
  screen: Screen;
  label: string;
  count?: number;
  attention?: boolean;
}

const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/**
 * The left rail: the mark and name, the five screens (Cmd/Ctrl+1-5), and at the foot the agent's
 * state and the one primary action, Scan now or Stop. Text only: no nav icons.
 */
export function Rail({ items, current, onGo, foot }: { items: RailItem[]; current: Screen; onGo: (s: Screen) => void; foot: ReactNode }) {
  return (
    <nav className="rail" aria-label="Screens">
      <div className="rail-brand">
        {MARK}
        <span>Split Finder</span>
      </div>
      <ul className="rail-list">
        {items.map((item, i) => (
          <li key={item.screen}>
            <a
              href={`#/${item.screen}`}
              className="rail-item"
              aria-current={item.screen === current ? 'page' : undefined}
              title={`${item.label} (${modLabel(String(i + 1), mac)})`}
              onClick={(e) => {
                e.preventDefault();
                onGo(item.screen);
              }}
            >
              <span>{item.label}</span>
              {item.count ? <Count n={item.count} attention={item.attention} label={`${item.count} open`} /> : null}
            </a>
          </li>
        ))}
      </ul>
      <div className="rail-foot">{foot}</div>
    </nav>
  );
}
