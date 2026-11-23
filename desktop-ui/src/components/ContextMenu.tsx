import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type SyntheticEvent } from 'react';
import { isMenuKey } from '../lib/keys';
import { stepMenu, type MenuItem } from '../lib/menus';
import './ContextMenu.css';

/**
 * The context menu (docs/design.md, Desktop app > Context menus): NSMenu in the popover's material, items at 22px,
 * the highlighted one in the accent, hairline separators, a key hint at the right. Right-click opens it at the
 * pointer; the menu key or Shift+F10 opens it at the focused row. Arrow keys move (greyed items are skipped), Return
 * or Space chooses, a letter jumps, Escape or a click elsewhere closes it and focus goes back to the row.
 */

interface OpenMenu {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  onPick: (id: string) => void;
  /** The row the menu is about, marked while it is open. */
  anchor: HTMLElement | null;
  opener: HTMLElement | null;
}

export interface MenuApi {
  /** Opens a menu for the row a mouse or keyboard event came from. Returns true when the event asked for one (so it can be stopped). */
  openFrom: (e: ReactMouseEvent | ReactKeyboardEvent, o: { label: string; items: MenuItem[]; onPick: (id: string) => void }) => boolean;
  close: () => void;
}

const Ctx = createContext<MenuApi | null>(null);

export function useMenu(): MenuApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMenu outside MenuProvider');
  return v;
}

/** Where a menu opens for an event: the pointer for a right-click, the row's lower left for the keyboard. Null for any other event. */
export function menuPoint(e: SyntheticEvent): { x: number; y: number } | null {
  const native = e.nativeEvent;
  if (native instanceof MouseEvent && e.type === 'contextmenu') {
    // A keyboard-opened contextmenu event reports the element's corner or 0,0; the row is the better place.
    if (native.clientX === 0 && native.clientY === 0 && e.target instanceof HTMLElement) {
      const r = e.target.getBoundingClientRect();
      return { x: r.left + 24, y: r.bottom - 4 };
    }
    return { x: native.clientX, y: native.clientY };
  }
  if (native instanceof KeyboardEvent && isMenuKey({ key: native.key, shift: native.shiftKey, meta: native.metaKey, ctrl: native.ctrlKey, alt: native.altKey })) {
    const el = (e.target instanceof HTMLElement ? e.target : null)?.closest<HTMLElement>('tr, li, [data-menu-row]') ?? (e.target instanceof HTMLElement ? e.target : null);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(32, r.width / 2), y: r.bottom - 4 };
  }
  return null;
}

export function MenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const close = useCallback(() => setMenu(null), []);

  const openFrom = useCallback<MenuApi['openFrom']>((e, o) => {
    const at = menuPoint(e);
    if (!at || o.items.length === 0) return false;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target instanceof HTMLElement ? e.target : null;
    setMenu({
      ...at,
      label: o.label,
      items: o.items,
      onPick: o.onPick,
      anchor: target?.closest<HTMLElement>('tr, li, [data-menu-row]') ?? null,
      opener: (document.activeElement as HTMLElement | null) ?? target,
    });
    return true;
  }, []);

  const api = useMemo<MenuApi>(() => ({ openFrom, close }), [openFrom, close]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {menu ? <MenuPanel key={`${menu.x}:${menu.y}:${menu.label}`} menu={menu} onClose={close} /> : null}
    </Ctx.Provider>
  );
}

function MenuPanel({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const items = menu.items;

  // Keep the whole menu on screen; open upward or leftward when the pointer is near an edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const m = 8;
    setPos({
      x: Math.max(m, Math.min(menu.x, window.innerWidth - w - m)),
      y: menu.y + h + m > window.innerHeight ? Math.max(m, menu.y - h) : menu.y,
    });
    el.focus({ preventScroll: true });
  }, [menu.x, menu.y]);

  useEffect(() => {
    menu.anchor?.classList.add('menu-target');
    return () => menu.anchor?.classList.remove('menu-target');
  }, [menu.anchor]);

  const finish = useCallback(
    (restore: boolean) => {
      // Focus goes back first, so a sheet the chosen item opens remembers the row, not the menu.
      if (restore && menu.opener?.isConnected) menu.opener.focus({ preventScroll: true });
      onClose();
    },
    [onClose, menu.opener],
  );

  useEffect(() => {
    const away = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      finish(false);
    };
    const quit = () => finish(false);
    window.addEventListener('mousedown', away, true);
    window.addEventListener('contextmenu', away, true);
    window.addEventListener('blur', quit);
    window.addEventListener('resize', quit);
    window.addEventListener('scroll', quit, true);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('contextmenu', away, true);
      window.removeEventListener('blur', quit);
      window.removeEventListener('resize', quit);
      window.removeEventListener('scroll', quit, true);
    };
  }, [finish]);

  const choose = (i: number) => {
    const item = items[i];
    if (!item || item.disabled) return;
    finish(true);
    // The row's own action runs after the menu has gone, so a sheet it opens takes the focus the menu returned.
    menu.onPick(item.id);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => stepMenu(items, a, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => stepMenu(items, a < 0 ? 0 : a, -1));
        return;
      case 'Home':
        e.preventDefault();
        setActive(stepMenu(items, -1, 1));
        return;
      case 'End':
        e.preventDefault();
        setActive(stepMenu(items, 0, -1));
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(active);
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        finish(true);
        return;
      case 'Tab':
        e.preventDefault();
        finish(true);
        return;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const from = active + 1;
          const order = [...items.keys()].map((_, i) => (from + i) % items.length);
          const hit = order.find((i) => !items[i]!.disabled && items[i]!.label.toLowerCase().startsWith(e.key.toLowerCase()));
          if (hit !== undefined) setActive(hit);
        }
    }
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={menu.label}
      aria-activedescendant={active >= 0 ? `ctx-${active}` : undefined}
      tabIndex={-1}
      data-tauri-drag-region="false"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={item.id} role="none">
          {item.separatorBefore ? <div className="ctx-sep" role="separator" /> : null}
          <div
            id={`ctx-${i}`}
            role="menuitem"
            className={`ctx-item${i === active ? ' ctx-active' : ''}${item.danger ? ' ctx-danger' : ''}`}
            aria-disabled={item.disabled ? true : undefined}
            title={item.disabled}
            onMouseMove={() => !item.disabled && setActive(i)}
            onMouseLeave={() => setActive((a) => (a === i ? -1 : a))}
            onClick={() => choose(i)}
          >
            <span className="ctx-label">{item.label}</span>
            {item.hint ? <span className="ctx-hint">{item.hint}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
