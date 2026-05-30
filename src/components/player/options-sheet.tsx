import { useEvent } from 'expo';
import type { AudioTrack, SubtitleTrack, VideoPlayer } from 'expo-video';
import { Modal, Pressable, ScrollView, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';

export type SheetMode = 'cc' | 'settings' | null;

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function trackKey(track: SubtitleTrack | AudioTrack): string {
  return track.id ?? `${track.language}::${track.label}`;
}

function trackLabel(track: SubtitleTrack | AudioTrack): string {
  return track.label || track.name || track.language || 'Track';
}

type RowProps = { label: string; active: boolean; onPress: () => void };

function Row({ label, active, onPress }: RowProps) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between px-4 py-3.5 active:opacity-70">
      <ThemedText className={`text-white ${active ? 'font-semibold' : ''}`}>{label}</ThemedText>
      {active && <Icon name="check" size={20} color="#4aa3ff" />}
    </Pressable>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <ThemedText className="mb-1 mt-3 px-4 text-xs font-semibold uppercase text-white/50">
      {children}
    </ThemedText>
  );
}

type OptionsSheetProps = {
  player: VideoPlayer;
  mode: SheetMode;
  onClose: () => void;
};

export function OptionsSheet({ player, mode, onClose }: OptionsSheetProps) {
  const { availableSubtitleTracks } = useEvent(player, 'availableSubtitleTracksChange', {
    availableSubtitleTracks: player.availableSubtitleTracks,
  });
  const { subtitleTrack } = useEvent(player, 'subtitleTrackChange', {
    subtitleTrack: player.subtitleTrack,
  });
  const { availableAudioTracks } = useEvent(player, 'availableAudioTracksChange', {
    availableAudioTracks: player.availableAudioTracks,
  });
  const { audioTrack } = useEvent(player, 'audioTrackChange', { audioTrack: player.audioTrack });
  const { playbackRate } = useEvent(player, 'playbackRateChange', {
    playbackRate: player.playbackRate,
  });

  const selectSubtitle = (track: SubtitleTrack | null) => {
    // eslint-disable-next-line react-hooks/immutability
    player.subtitleTrack = track;
  };
  const selectAudio = (track: AudioTrack) => {
    // eslint-disable-next-line react-hooks/immutability
    player.audioTrack = track;
  };
  const selectRate = (rate: number) => {
    // eslint-disable-next-line react-hooks/immutability
    player.playbackRate = rate;
  };

  return (
    <Modal visible={mode !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-end bg-black/60" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="max-h-[70%] rounded-t-3xl bg-neutral-900 pb-10 pt-3">
          <View className="mb-2 items-center">
            <View className="h-1 w-10 rounded-full bg-white/25" />
          </View>

          <ScrollView>
            {mode === 'cc' && (
              <View>
                <ThemedText className="mb-1 px-4 text-lg font-bold text-white">Subtitles</ThemedText>
                <Row label="Off" active={!subtitleTrack} onPress={() => selectSubtitle(null)} />
                {availableSubtitleTracks.map((track) => (
                  <Row
                    key={trackKey(track)}
                    label={trackLabel(track)}
                    active={!!subtitleTrack && trackKey(subtitleTrack) === trackKey(track)}
                    onPress={() => selectSubtitle(track)}
                  />
                ))}
                {availableSubtitleTracks.length === 0 && (
                  <ThemedText className="px-4 py-3 text-white/50">
                    No subtitles available for this video.
                  </ThemedText>
                )}
              </View>
            )}

            {mode === 'settings' && (
              <View>
                <SectionTitle>Playback speed</SectionTitle>
                <View className="flex-row flex-wrap gap-2 px-4 py-1">
                  {SPEEDS.map((speed) => {
                    const active = Math.abs(playbackRate - speed) < 0.001;
                    return (
                      <Pressable
                        key={speed}
                        onPress={() => selectRate(speed)}
                        className={`rounded-full px-4 py-2 active:opacity-70 ${
                          active ? 'bg-accent' : 'bg-white/10'
                        }`}>
                        <ThemedText className="font-semibold text-white">
                          {speed === 1 ? 'Normal' : `${speed}x`}
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </View>

                <SectionTitle>Audio</SectionTitle>
                {availableAudioTracks.map((track) => {
                  const active = audioTrack
                    ? trackKey(audioTrack) === trackKey(track)
                    : !!track.isDefault;
                  return (
                    <Row
                      key={trackKey(track)}
                      label={trackLabel(track)}
                      active={active}
                      onPress={() => selectAudio(track)}
                    />
                  );
                })}
                {availableAudioTracks.length === 0 && (
                  <ThemedText className="px-4 py-3 text-white/50">
                    No alternate audio tracks.
                  </ThemedText>
                )}
              </View>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
