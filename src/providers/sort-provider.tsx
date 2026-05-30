import { createContext, use, useEffect, useState, type PropsWithChildren } from 'react';

import { Storage, StorageKeys } from '@/lib/storage';
import { DEFAULT_SORT, type SortOption } from '@/lib/media';

type SortContextValue = {
  sort: SortOption;
  setSort: (option: SortOption) => void;
};

const SortContext = createContext<SortContextValue | null>(null);

const VALID: SortOption[] = ['name-asc', 'name-desc', 'date-desc', 'date-asc', 'size-desc', 'size-asc'];

function isSortOption(value: string | null): value is SortOption {
  return value !== null && (VALID as string[]).includes(value);
}

export function SortProvider({ children }: PropsWithChildren) {
  const [sort, setSortState] = useState<SortOption>(DEFAULT_SORT);

  useEffect(() => {
    Storage.getItem(StorageKeys.sortOption).then((saved) => {
      if (isSortOption(saved)) setSortState(saved);
    });
  }, []);

  const setSort = (option: SortOption) => {
    setSortState(option);
    Storage.setItem(StorageKeys.sortOption, option);
  };

  return <SortContext value={{ sort, setSort }}>{children}</SortContext>;
}

export function useSort() {
  const context = use(SortContext);
  if (!context) {
    throw new Error('useSort must be used within a SortProvider');
  }
  return context;
}
