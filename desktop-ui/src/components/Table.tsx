import { useImperativeHandle, useRef, type ReactNode, type Ref } from 'react';
import { isMenuKey, listKey, pressOf } from '../lib/keys';
import type { MenuItem } from '../lib/menus';
import { ariaSort, nextSort, type SortDirection, type SortState } from '../lib/sort';
import { useMenu } from './ContextMenu';
import { Glyph } from './Glyph';
import './Table.css';

export interface Column<T, K extends string> {
  key: K;
  label: string;
  /** A short visible head when the label would not fit; the full label stays for screen readers. */
  short?: string;
  sortable?: boolean;
  /** A narrow column whose control says what it is: the head is read by screen readers and not drawn. */
  hideLabel?: boolean;
  /** Figures start high to low, words A to Z. */
  natural?: SortDirection;
  align?: 'left' | 'right';
  /** CSS width class: col-title, col-fig, col-fig-wide, col-time, col-action. */
  width: string;
  /** Hidden when the table is narrower than this (a small window, or the detail pane is open). */
  hideBelow?: 900 | 720 | 560;
  render: (row: T) => ReactNode;
}

/** What a row's right-click offers, and what choosing an item does. */
export interface RowMenu {
  label: string;
  items: MenuItem[];
  onPick: (id: string) => void;
}

export interface TableHandle {
  focusRow(index: number): void;
}

/**
 * A real <table>. Each row's first cell holds a <button> stretched over the row, so a click
 * anywhere on the row opens it and keyboard users get a real control: J/K or the arrows move,
 * Enter opens, Escape closes the pane. Controls inside a row (Look up) sit above the stretch.
 */
export function Table<T, K extends string>({
  caption,
  rows,
  columns,
  rowKey,
  rowLabel,
  sort,
  onSort,
  selected,
  onOpen,
  onClose,
  handle,
  menu,
}: {
  caption: string;
  rows: T[];
  columns: Column<T, K>[];
  rowKey: (row: T) => string;
  /** The open button's accessible name. */
  rowLabel: (row: T) => string;
  sort: SortState<K>;
  onSort: (s: SortState<K>) => void;
  selected: string | null;
  onOpen: (row: T) => void;
  onClose?: () => void;
  handle?: Ref<TableHandle>;
  /** The row's context menu (right-click, the menu key, Shift+F10); none when absent. */
  menu?: (row: T) => RowMenu | null;
}) {
  const ctx = useMenu();
  const body = useRef<HTMLTableSectionElement>(null);
  const focusRow = (i: number) => {
    const buttons = body.current?.querySelectorAll<HTMLButtonElement>('.row-open');
    if (!buttons?.length) return;
    buttons[Math.max(0, Math.min(buttons.length - 1, i))]?.focus();
  };
  useImperativeHandle(handle, () => ({ focusRow }));

  const openMenu = (e: React.MouseEvent | React.KeyboardEvent, row: T | undefined) => {
    const m = row && menu ? menu(row) : null;
    if (m) ctx.openFrom(e, m);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (menu && isMenuKey({ key: e.key, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey })) {
      const tr = (e.target as HTMLElement).closest('tr');
      const at = tr ? Array.from(body.current?.rows ?? []).indexOf(tr as HTMLTableRowElement) : -1;
      openMenu(e, rows[at]);
      return;
    }
    const a = listKey(pressOf(e.nativeEvent));
    if (!a) return;
    const tr = (e.target as HTMLElement).closest('tr');
    const index = tr ? Array.from(body.current?.rows ?? []).indexOf(tr as HTMLTableRowElement) : -1;
    if (a.type === 'next' || a.type === 'prev') {
      e.preventDefault();
      focusRow(index + (a.type === 'next' ? 1 : -1));
    } else if (a.type === 'open') {
      const row = rows[index];
      if (row) {
        e.preventDefault();
        onOpen(row);
      }
    } else if (a.type === 'close' && onClose) {
      onClose();
    }
  };

  return (
    <div className="table-wrap">
      <table className="table table-rows" onKeyDown={onKeyDown}>
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} className={`${c.width}${c.hideBelow ? ` col-hide-${c.hideBelow}` : ''}`} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={c.sortable ? ariaSort(sort, c.key) : undefined}
                className={`th-${c.align ?? 'left'}${c.hideBelow ? ` col-hide-${c.hideBelow}` : ''}`}
              >
                {c.sortable ? (
                  <button type="button" className="th-sort" onClick={() => onSort(nextSort(sort, c.key, c.natural ?? 'desc'))}>
                    <span aria-hidden={c.short ? true : undefined}>{c.short ?? c.label}</span>
                    {c.short ? <span className="sr-only">{c.label}</span> : null}
                    <span className={`th-arrow${sort.key === c.key && sort.dir === 'asc' ? ' th-arrow-up' : ''}`} aria-hidden="true">
                      {sort.key === c.key ? <Glyph name="chevron-down" size={10} /> : null}
                    </span>
                  </button>
                ) : (
                  <span className={c.hideLabel ? 'sr-only' : 'th-plain'}>{c.label}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={body}>
          {rows.map((row) => {
            const key = rowKey(row);
            const on = key === selected;
            return (
              <tr key={key} className={on ? 'tr-on' : undefined} onContextMenu={menu ? (e) => openMenu(e, row) : undefined}>
                {columns.map((c, i) => (
                  <td key={c.key} className={`td-${c.align ?? 'left'}${c.hideBelow ? ` col-hide-${c.hideBelow}` : ''}`}>
                    {i === 0 ? (
                      <button type="button" className="row-open" aria-current={on || undefined} aria-label={rowLabel(row)} onClick={() => onOpen(row)} />
                    ) : null}
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
