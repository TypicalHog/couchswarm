export function isMkv(filename: string) {
  return /\.mkv$/i.test(filename);
}

// The room shares one fileIndex, so the tie-break compares code units rather than the viewer's locale.
export function videoFiles<T extends { name: string; path: string; length: number }>(files: T[]): T[] {
  return files.filter(file => /\.(mkv|mp4|webm|m4v|ogv)$/i.test(file.name))
    .sort((a, b) => b.length - a.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
