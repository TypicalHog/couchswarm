'use client';
import { useEffect, useRef } from 'react';
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  return <div className="shell"><main><div className="room-heading"><div><div className="eyebrow"><span className="dot"/>SOMETHING WENT WRONG</div><h1 tabIndex={-1} ref={headingRef}>The room hit a snag.</h1></div></div><div className="readiness" role="alert"><div><strong>We lost the picture for a moment.</strong><p>Reload the room to take your seat again. Your seat is kept in this tab.</p></div><button className="primary-button" onClick={() => reset()}>Reload the room</button></div></main></div>;
}
