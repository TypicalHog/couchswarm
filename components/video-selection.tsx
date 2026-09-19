'use client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function VideoSelection({ files, value, disabled, onChange }:
  { files: { name: string; path: string; size: number }[]; value: number; disabled: boolean; onChange: (index: number) => void }) {
  return <div className="video-selection"><label id="video-file-label" htmlFor="video-file">Video in this torrent</label><Select value={String(value)} onValueChange={next => { if (next !== null) onChange(Number(next)); }} disabled={disabled}><SelectTrigger id="video-file" aria-labelledby="video-file-label" className="w-full min-w-0" title={files[value]?.path}><SelectValue>{files[value]?.name}</SelectValue></SelectTrigger><SelectContent>{files.map((file, i) => <SelectItem key={i} value={String(i)} title={file.path}>{file.name}</SelectItem>)}</SelectContent></Select></div>;
}
