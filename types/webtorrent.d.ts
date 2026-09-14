declare module 'webtorrent/dist/webtorrent.min.js' {
  export interface TorrentFile {
    name: string; path: string; length: number; downloaded: number; progress: number;
    streamURL: string;
    select(): void; streamTo(video: HTMLVideoElement): void;
    on(event: 'iterator', listener: (info: { iterator: AsyncIterable<Uint8Array>; req: { headers: Record<string, string> } }, replace: (value: AsyncIterable<Uint8Array>) => void) => void): void;
  }
  export interface Torrent {
    infoHash?: string;
    once(event: string, listener: (...args: unknown[]) => void): Torrent;
    addPeer(peer: unknown): boolean;
    name: string; files: TorrentFile[]; downloadSpeed: number; numPeers: number;
    on(event: string, listener: (...args: unknown[]) => void): Torrent;
    addWebSeed(url: string): void;
  }
  export default class WebTorrent {
    constructor(options?: { tracker?: { announce?: string[] } });
    on(event: string, listener: (...args: unknown[]) => void): this;
    add(source: string | Uint8Array, options: { strategy: string; deselect: boolean; destroyStoreOnDestroy: boolean; storeCacheSlots?: number }, callback: (torrent: Torrent) => void): Torrent;
    createServer(options: { controller: ServiceWorkerRegistration }): unknown;
    destroy(callback?: () => void): void;
  }
}
