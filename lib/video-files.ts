export function isMkv(filename: string) {
  return /\.mkv$/i.test(filename);
}

export function videoFiles<T extends { name: string; path: string; length: number }>(files: T[]): T[] {
  return files.filter(file => /\.(mkv|mp4|webm|m4v|ogv)$/i.test(file.name))
    .sort((a, b) => b.length - a.length || a.path.localeCompare(b.path));
}
