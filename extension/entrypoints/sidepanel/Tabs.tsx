export type TabId = 'deals' | 'this-page' | 'review';

export interface TabsProps {
  active: TabId;
  dealCount: number;
  reviewCount: number;
  onChange: (tab: TabId) => void;
}

export function Tabs({ active, dealCount, reviewCount, onChange }: TabsProps) {
  const current = (id: TabId) => (active === id ? 'true' : undefined);
  return (
    <nav aria-label="Views" className="tabs">
      <button type="button" className="tab" aria-current={current('deals')} onClick={() => onChange('deals')}>
        Deals <span className="count">{dealCount}</span>
      </button>
      <button type="button" className="tab" aria-current={current('this-page')} onClick={() => onChange('this-page')}>
        This page
      </button>
      <button type="button" className="tab" aria-current={current('review')} onClick={() => onChange('review')}>
        Review{' '}
        <span className="count" data-tag={reviewCount > 0 ? 'attention' : undefined}>
          {reviewCount}
        </span>
      </button>
    </nav>
  );
}
