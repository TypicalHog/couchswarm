'use client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MAX_FILE_INDEX } from '@/lib/video-files';

export function VideoSelection({ files, value, disabled, onChange }:
  { files: { name: string; path: string; size: number }[]; value: number; disabled: boolean; onChange: (index: number) => void }) {
  // Everything past MAX_FILE_INDEX is refused by the room, so it is named rather than offered. The list is
  // sorted largest first, which makes the ones that fall off the end the smallest.
  const unlisted = files.length - MAX_FILE_INDEX - 1;
  return <div className="video-selection"><label id="video-file-label" htmlFor="video-file">Video in this torrent</label><Select value={String(value)} onValueChange={next => { if (next !== null) onChange(Number(next)); }} disabled={disabled}><SelectTrigger id="video-file" aria-labelledby="video-file-label" className="w-full min-w-0 min-h-8 whitespace-normal wrap-anywhere data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-none" title={files[value]?.path}><SelectValue>{files[value]?.name}</SelectValue></SelectTrigger><SelectContent>{files.slice(0, MAX_FILE_INDEX + 1).map((file, i) => <SelectItem key={i} value={String(i)} title={file.path}>{file.name}</SelectItem>)}{unlisted > 0 && <SelectItem value="unlisted" disabled>{unlisted === 1 ? '1 smaller video is' : `${unlisted} smaller videos are`} past this room’s limit.</SelectItem>}</SelectContent></Select></div>;
}
