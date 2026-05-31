import { useCallback, useState } from 'react';

/**
 * Multi-select state for list screens. Selection mode is "active" whenever at
 * least one item is selected (long-press selects the first; deselecting all
 * exits the mode). `toggle`/`clear` are stable so effects can depend on them.
 */
export function useSelection() {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = useCallback(
    (id: string) =>
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  return {
    selectedIds,
    count: selectedIds.size,
    active: selectedIds.size > 0,
    isSelected: (id: string) => selectedIds.has(id),
    toggle,
    clear,
  };
}
