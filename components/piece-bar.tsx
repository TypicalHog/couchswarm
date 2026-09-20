'use client';
import { useEffect, useRef } from 'react';
import { DONE, DOWNLOADING } from '@/lib/piece-state';

// A movie is thousands of pieces against a bar a few hundred pixels wide, so this is one canvas rather than an
// element each. Every device pixel column stands for a run of pieces: a run holding anything still arriving is
// drawn as arriving, since one piece in flight among fifty is the part worth seeing, and every other column
// sits between the two ends by how much of its run is saved.
const PENDING_RGB = [44, 53, 43], DONE_RGB = [166, 211, 123], ARRIVING = '#edffd4';
// A swarm holds one or two pieces part-written at a time, which on a feature film is a tenth of a percent of
// the bar: true to the width and invisible. Each run of them is drawn at least this many CSS pixels wide.
const MARK = 2;

export function PieceBar({ read }: { read: () => Uint8Array | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const states = read();
      // Sized in device pixels, so a column is never resampled into a blur of the colours on either side of it.
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const context = canvas.getContext('2d');
      if (!context) return;
      // What a cleared canvas shows is the track the stylesheet paints, which is a run with nothing saved in it.
      context.clearRect(0, 0, width, height);
      if (!states?.length) return;
      const marks = [];
      for (let column = 0; column < width; column++) {
        const from = Math.floor(column * states.length / width);
        const to = Math.max(from + 1, Math.floor((column + 1) * states.length / width));
        let done = 0, arriving = 0;
        for (let index = from; index < to; index++) {
          if (states[index] === DONE) done++;
          else if (states[index] === DOWNLOADING) arriving++;
        }
        if (arriving) marks.push(column);
        context.fillStyle = `rgb(${PENDING_RGB.map((value, channel) => Math.round(value + (DONE_RGB[channel] - value) * done / (to - from))).join(' ')})`;
        context.fillRect(column, 0, 1, height);
      }
      // Over the finished columns, so a run that is mostly saved still shows the piece of it that is not.
      const span = Math.max(1, Math.round(MARK * ratio));
      context.fillStyle = ARRIVING;
      for (const column of marks) context.fillRect(Math.min(column, Math.max(0, width - span)), 0, span, height);
    };
    draw();
    // The percentage beside the file name is read off the same torrent once a second; this keeps step with it.
    const timer = setInterval(draw, 1000);
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => { clearInterval(timer); observer.disconnect(); };
  }, [read]);
  // A picture of the percentage on the line above it, and the part it adds — which pieces those bytes are — is
  // nothing to act on, so it is left out of the accessibility tree rather than read out as a shape with a name.
  return <canvas className="piece-bar" ref={canvasRef} aria-hidden="true"/>;
}
