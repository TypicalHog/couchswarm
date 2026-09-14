import { ImageResponse } from 'next/og';

export const alt = 'CouchSwarm — Movie night, together';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Site-wide art on purpose: an invite unfurls through the root document, so the room id and secret stay out of the preview.
export default function OpengraphImage() {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 100px', background: '#101411', color: '#eff3ed' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 30 }}>
        {/* The favicon artwork inlined — satori cannot fetch /favicon.svg while rendering. */}
        <svg width={140} height={140} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width={32} height={32} rx={9} fill="#c2f28a"/><g transform="translate(4 4)" fill="none" stroke="#1c2c19" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"/><path d="M2 16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0zM4 18v2M20 18v2M12 4v9"/></g></svg>
        <div style={{ display: 'flex', fontSize: 96, letterSpacing: -4 }}>CouchSwarm</div>
      </div>
      <div style={{ display: 'flex', marginTop: 44, fontSize: 40, lineHeight: 1.4, color: '#a2aea0' }}>One room, one play button. Watch browser-compatible torrents in sync with your people.</div>
    </div>,
    size,
  );
}
