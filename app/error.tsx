'use client';
import { useEffect, useRef } from 'react';
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  useEffect(() => { console.error(error); }, [error]);
  // A render that failed on a chunk this deployment no longer serves keeps failing on it: React holds the
  // rejected import, so only a fresh document recovers. Clearing the boundary stays on offer for the errors
  // that pass, because it keeps the movie already downloaded in this tab.
  return <div className="shell"><main><div className="room-heading"><div><div className="eyebrow"><span className="dot"/>SOMETHING WENT WRONG</div><h1 tabIndex={-1} ref={headingRef}>The room hit a snag.</h1></div></div><div className="readiness" role="alert"><div><strong>We lost the picture for a moment.</strong><p>Reload the room to take your seat again. Your seat is kept in this tab.</p>{error.digest && <p><small>Reference: {error.digest}</small></p>}<button className="quiet-button" onClick={() => reset()}>Try again without reloading</button></div><button className="primary-button" onClick={() => location.reload()}>Reload the room</button></div></main></div>;
}
