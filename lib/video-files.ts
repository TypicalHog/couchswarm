export function isMkv(filename: string) {
  return /\.mkv$/i.test(filename);
}

// The room stores one fileIndex for everyone and the API bounds it, so the picker has to stop where the room
// does: an entry past this is refused with 'Invalid video selection.' and nothing on screen would say why.
export const MAX_FILE_INDEX = 10000;

// The room shares one fileIndex, so the tie-break compares code units rather than the viewer's locale.
export function videoFiles<T extends { name: string; path: string; length: number }>(files: T[]): T[] {
  return files.filter(file => /\.(mkv|mp4|webm|m4v|ogv)$/i.test(file.name))
    .sort((a, b) => b.length - a.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
