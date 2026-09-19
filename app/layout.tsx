import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'CouchSwarm — Movie night, together',
  description: 'One room, one play button. Watch browser-compatible torrents in sync with your people.',
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }, { url: '/favicon.ico', sizes: '32x32' }], apple: '/apple-touch-icon.png' },
  // Vercel derives the deployment URL itself; elsewhere the social image needs an absolute base, or the build warns and falls back to localhost.
  metadataBase: URL.parse(process.env.COUCHSWARM_PUBLIC_ORIGIN || '') ?? undefined,
  openGraph: { title: 'CouchSwarm — Movie night, together', description: 'One room, one play button. Watch browser-compatible torrents in sync with your people.', type: 'website', siteName: 'CouchSwarm' },
  twitter: { card: 'summary_large_image', title: 'CouchSwarm — Movie night, together', description: 'One room, one play button. Watch browser-compatible torrents in sync with your people.' },
};

// resizes-content shrinks the layout viewport when the on-screen keyboard opens, so a centred dialog and its 100dvh cap follow the visible strip.
export const viewport: Viewport = { themeColor: '#101411', interactiveWidget: 'resizes-content' };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        {/* Vercel-only: a local dev server renders neither script. */}
        {process.env.VERCEL && <><Analytics/><SpeedInsights/></>}
      </body>
    </html>
  );
}
