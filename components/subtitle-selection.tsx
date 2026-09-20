'use client';
import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Opening the picker mounts every option at once, and a torrent can carry tens of thousands of subtitle files:
// past this many the tab stops responding for seconds, so the rest stay reachable through Upload.
const LISTED = 500;

// Everyone picks their own, so this stays enabled for guests: nothing here is room state.
export function SubtitleSelection({ subtitles, value, busy, error, onChange }:
  { subtitles: { name: string; path: string }[]; value: number | File | null; busy: boolean; error: string; onChange: (next: number | File | null) => void }) {
  const uploadRef = useRef<HTMLInputElement>(null);
  // Kept here so the file stays on the list after trying one of the torrent's own, rather than only while it is chosen.
  const [uploaded, setUploaded] = useState<File | null>(null);
  const chosen = value instanceof File ? 'upload' : value === null ? 'off' : String(value);
  return <div className="video-selection subtitle-selection">
    <label id="subtitle-label" htmlFor="subtitle">Subtitles</label>
    <Select value={chosen} onValueChange={next => { if (next !== null) onChange(next === 'upload' ? uploaded : next === 'off' ? null : Number(next)); }}>
      <SelectTrigger id="subtitle" aria-labelledby="subtitle-label" className="w-full min-h-8 whitespace-normal wrap-anywhere data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-none" aria-describedby={error ? 'subtitle-error' : undefined}>
        <SelectValue>{busy ? 'Loading…' : value instanceof File ? value.name : value === null ? 'Off' : subtitles[value]?.name}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="off">Off</SelectItem>
        {subtitles.slice(0, LISTED).map((file, i) => <SelectItem key={i} value={String(i)} title={file.path}>{file.name}</SelectItem>)}
        {subtitles.length > LISTED && <SelectItem disabled>{subtitles.length - LISTED} more not listed. Upload the one you want.</SelectItem>}
        {uploaded && <SelectItem value="upload" title="From this device">{uploaded.name}</SelectItem>}
      </SelectContent>
    </Select>
    <button type="button" className="quiet-button" onClick={() => uploadRef.current?.click()}><Upload size={14}/> Upload</button>
    {/* The file never leaves this device, so everyone else keeps whatever they chose for themselves. */}
    <input ref={uploadRef} type="file" accept=".srt,.vtt,.ass,.ssa" hidden aria-label="Upload a subtitle file"
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) { setUploaded(file); onChange(file); } }}/>
    {error && <div id="subtitle-error" className="error" role="alert">{error}</div>}
  </div>;
}
