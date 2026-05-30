import { Pressable, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import type { SortOption } from '@/lib/media';

export const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'name-asc', label: 'Name (A–Z)' },
  { value: 'name-desc', label: 'Name (Z–A)' },
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'size-desc', label: 'Largest first' },
  { value: 'size-asc', label: 'Smallest first' },
];

type SortOptionsListProps = {
  value: SortOption;
  onChange: (option: SortOption) => void;
};

export function SortOptionsList({ value, onChange }: SortOptionsListProps) {
  const { colors } = useTheme();

  return (
    <View className="overflow-hidden rounded-2xl bg-surface">
      {SORT_OPTIONS.map((option, index) => {
        const active = value === option.value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            className={`flex-row items-center justify-between px-4 py-3.5 active:opacity-70 ${
              index > 0 ? 'border-t border-background' : ''
            }`}>
            <ThemedText className={active ? 'font-semibold text-accent' : ''}>
              {option.label}
            </ThemedText>
            {active && <Icon name="check" size={20} color={colors.accent} />}
          </Pressable>
        );
      })}
    </View>
  );
}
