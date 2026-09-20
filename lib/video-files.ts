export function isMkv(filename: string) {
  return /\.mkv$/i.test(filename);
}

// The room stores one fileIndex for everyone and the API bounds it, so the picker has to stop where the room
// does: an entry past this is refused with 'Invalid video selection.' and nothing on screen would say why.
export const MAX_FILE_INDEX = 10000;

// The room shares one fileIndex, so the tie-break compares code units rather than the viewer's locale.
// .mov is QuickTime, which every browser here plays when it carries H.264, so refusing it sent people after a
// file they already had. .ogv stays for Firefox, the only one of them with a Theora decoder, but is left out of
// the sentences telling people what to look for: anywhere else the picture never arrives, which the player says
// for itself once the metadata lands. Mirrored by videoFiles in helper/torrent-helper.mjs.
export function videoFiles<T extends { name: string; path: string; length: number }>(files: T[]): T[] {
  return files.filter(file => /\.(mkv|mp4|m4v|mov|webm|ogv)$/i.test(file.name))
    .sort((a, b) => b.length - a.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
