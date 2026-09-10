declare module '@thaunknown/simple-peer' {
  export default class Peer {
    constructor(options: { initiator: boolean; trickle: boolean; config: { iceServers: RTCIceServer[] } });
    id: string;
    destroyed: boolean;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    signal(value: unknown): void;
    destroy(): void;
  }
}
