declare module 'webtorrent/dist/webtorrent.min.js' {
  // Reading a file selects only the pieces the read covers and releases them when the stream ends, so a
  // destroyed stream is the only way to abandon a read: the promise forms never settle once the torrent is
  // gone. Destroying it releases the pieces but does not end a parked read either — that wait never settles.
  export interface TorrentFileStream {
    on(event: 'data', listener: (chunk: Uint8Array) => void): TorrentFileStream;
    on(event: 'end' | 'close', listener: () => void): TorrentFileStream;
    on(event: 'error', listener: (error: Error) => void): TorrentFileStream;
    destroy(): void;
  }
  export interface TorrentFile {
    name: string; path: string; length: number; downloaded: number; progress: number;
    streamURL: string;
    select(): void; streamTo(video: HTMLVideoElement): void;
    createReadStream(): TorrentFileStream;
    on(event: 'iterator', listener: (info: { iterator: AsyncIterable<Uint8Array>; req: { headers: Record<string, string> } }, replace: (value: AsyncIterable<Uint8Array>) => void) => void): void;
  }
  export interface Torrent {
    infoHash?: string;
    // Present once metadata has arrived: one bit per piece, marking what this client verified in the store.
    bitfield?: { buffer: Uint8Array };
    once(event: string, listener: (...args: unknown[]) => void): Torrent;
    addPeer(peer: unknown): boolean;
    name: string; files: TorrentFile[]; downloadSpeed: number; numPeers: number;
    on(event: string, listener: (...args: unknown[]) => void): Torrent;
    addWebSeed(url: string): void;
  }
  export default class WebTorrent {
    constructor(options?: { tracker?: { announce?: string[] } });
    on(event: string, listener: (...args: unknown[]) => void): this;
    add(source: string | Uint8Array, options: { strategy: string; deselect: boolean; destroyStoreOnDestroy: boolean; storeCacheSlots?: number; bitfield?: Uint8Array }, callback: (torrent: Torrent) => void): Torrent;
    createServer(options: { controller: ServiceWorkerRegistration }): unknown;
    destroy(callback?: () => void): void;
  }
}
