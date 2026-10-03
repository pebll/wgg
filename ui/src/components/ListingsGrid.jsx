import { Empty, Pagination, Spin } from '@douyinfe/semi-ui-19';
import ListingCard from './ListingCard.jsx';

/** Responsive card grid with server-side paging. */
export default function ListingsGrid({
  listings,
  total,
  loading,
  filters,
  onChange,
  selectedId,
  onSelect,
  onDismiss,
  onMessaged,
  onRestore,
  badgeThreshold,
  targetName,
}) {
  return (
    <Spin spinning={loading}>
      {listings.length === 0 && !loading ? (
        <Empty className="grid__empty" title="No offers match" description="Try a longer max age or lower min score." />
      ) : (
        <div className="grid">
          {listings.map((item) => (
            <ListingCard
              key={item.id}
              item={item}
              sort={filters.sort}
              selected={item.id === selectedId}
              onSelect={onSelect}
              onDismiss={onDismiss}
              onMessaged={onMessaged}
              onRestore={onRestore}
              badgeThreshold={badgeThreshold}
              targetName={targetName}
            />
          ))}
        </div>
      )}
      {total > filters.pageSize && (
        <div className="grid__pager">
          <Pagination
            total={total}
            currentPage={filters.page}
            pageSize={filters.pageSize}
            onPageChange={(page) => onChange({ page })}
          />
        </div>
      )}
    </Spin>
  );
}
