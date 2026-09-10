'use client';
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="shell"><div className="room-heading"><div><div className="eyebrow"><span className="dot"/>SOMETHING WENT WRONG</div><h1>The room hit a snag.</h1></div></div><div className="readiness"><div><strong>We lost the picture for a moment.</strong><p>Reload the room to take your seat again. Your seat is kept in this tab.</p></div><button className="primary-button" onClick={() => reset()}>Reload the room</button></div></div>;
}
