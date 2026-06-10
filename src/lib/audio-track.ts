/**
 * Audio-track selection helpers shared by the player (auto-select on load) and
 * the options sheet (remember a manual choice).
 *
 * Preference priority when a video loads:
 *   1. the user's saved language (if a matching track exists)
 *   2. Hindi, if available
 *   3. the video's own default track (return null → leave it alone)
 */
import type { AudioTrack } from 'expo-video';

/** Stable string used to remember a track across videos (ISO language, else label). */
export function audioTrackLanguage(track: AudioTrack): string {
  return track.language || track.label || track.name || '';
}

export function isHindiTrack(track: AudioTrack): boolean {
  const lang = (track.language ?? '').toLowerCase();
  const label = (track.label || track.name || '').toLowerCase();
  return (
    lang === 'hi' ||
    lang === 'hin' ||
    lang.startsWith('hi-') ||
    label.includes('hindi')
  );
}

export function pickPreferredAudioTrack(
  tracks: AudioTrack[],
  preferred: string | null,
): AudioTrack | null {
  if (!tracks?.length) return null;
  if (preferred) {
    const match = tracks.find(
      (t) => audioTrackLanguage(t).toLowerCase() === preferred.toLowerCase(),
    );
    if (match) return match;
  }
  return tracks.find(isHindiTrack) ?? null;
}
