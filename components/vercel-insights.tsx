'use client';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';

// A room's address carries its invite in the fragment, and a pairing link its code, because no request sends a
// fragment - except these two, whose scripts report location.href as it stands. Only the path leaves the page.
const pathOnly = <T extends { url: string }>(event: T) => ({ ...event, url: event.url.replace(/[?#][\s\S]*/, '') });

export function VercelInsights() {
  return <><Analytics beforeSend={pathOnly}/><SpeedInsights beforeSend={pathOnly}/></>;
}
