import type { HeliosState } from "@homebase/shared";
import { useEffect, useRef } from "react";

// The centrepiece: a slowly turning neural structure drawn on a canvas.
//
// This is the first version (plain 2D canvas, points and connections in
// perspective). Phase 4 replaces the drawing with a WebGL scene, but the
// contract stays the same: the core says which state HELIOS is in, and the
// brain shows it. Nothing here decides anything.


/** How each state looks: turning speed (radians per second) and signals per second. */
const ACTIVITY: Record<HeliosState, { spin: number; signals: number }> = {
  idle: { spin: 0.07, signals: 0.8 },
  listening: { spin: 0.03, signals: 2 },
  thinking: { spin: 0.1, signals: 7 },
  searching: { spin: 0.14, signals: 12 },
  speaking: { spin: 0.06, signals: 4 },
  acting: { spin: 0.11, signals: 9 },
  presenting: { spin: 0.02, signals: 0.5 },
};

type Point = { x: number; y: number; z: number };
type Signal = { edge: number; forward: boolean; progress: number; speed: number };

/** Repeatable random numbers: the same seed always draws the same brain. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points on and inside a brain-like shape, each linked to its nearest neighbours. */
function buildBrain(count: number, seed: number): { points: Point[]; edges: [number, number][]; links: number[][] } {
  const random = seeded(seed);
  const points: Point[] = [];
  const onSphere = (radius: number): Point => {
    const u = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const ring = Math.sqrt(1 - u * u);
    return { x: radius * ring * Math.cos(angle), y: radius * u, z: radius * ring * Math.sin(angle) };
  };

  while (points.length < count) {
    const pick = random();
    if (pick < 0.9) {
      // The two hemispheres: most points near the surface, some inside.
      const p = onSphere(pick < 0.72 ? 0.86 + random() * 0.14 : 0.3 + random() * 0.55);
      const folds = 1 + 0.07 * Math.sin(9 * p.x + 4 * p.z) * Math.cos(8 * p.y + 5 * p.z);
      const point = { x: p.x * 0.8 * folds, y: p.y * 0.68 * folds + 0.06, z: p.z * 1.02 * folds };
      if (Math.abs(point.x) < 0.05 && point.y > -0.15) continue; // the groove between the halves
      if (point.y < -0.42) continue; // a flatter underside
      points.push(point);
    } else if (pick < 0.98) {
      // The cerebellum: a smaller, denser lobe low at the back.
      const p = onSphere(0.5 + random() * 0.5);
      points.push({ x: p.x * 0.42, y: p.y * 0.24 - 0.52, z: p.z * 0.34 - 0.6 });
    } else {
      // The stem, leading down.
      const t = random();
      points.push({ x: (random() - 0.5) * 0.08, y: -0.5 - t * 0.42, z: -0.28 - t * 0.12 + (random() - 0.5) * 0.06 });
    }
  }

  const edges: [number, number][] = [];
  const seen = new Set<number>();
  for (let a = 0; a < points.length; a++) {
    const near: [number, number][] = [];
    const pa = points[a] as Point;
    for (let b = 0; b < points.length; b++) {
      if (a === b) continue;
      const pb = points[b] as Point;
      const distance = (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2 + (pa.z - pb.z) ** 2;
      if (distance < 0.022) near.push([distance, b]);
    }
    near.sort((first, second) => first[0] - second[0]);
    for (const [, b] of near.slice(0, 3)) {
      const key = a < b ? a * 100_000 + b : b * 100_000 + a;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([a, b]);
    }
  }
  const links: number[][] = points.map(() => []);
  edges.forEach(([a, b], index) => {
    links[a]?.push(index);
    links[b]?.push(index);
  });
  return { points, edges, links };
}

const DEPTH_LEVELS = 6;

export function Brain({ state = "idle", growth = 0, ambient = false }: { state?: HeliosState; growth?: number; ambient?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The drawing loop reads the latest props from here, so a state change
  // does not rebuild the brain or restart the animation.
  const live = useRef({ state, ambient });
  live.current = { state, ambient };

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    // More memory, more neurons: `growth` runs from 0 (new) to 1 (years of use).
    const { points, edges, links } = buildBrain(Math.round(900 + Math.min(1, Math.max(0, growth)) * 900), 7);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const screenX = new Float32Array(points.length);
    const screenY = new Float32Array(points.length);
    const depth = new Float32Array(points.length);
    const signals: Signal[] = [];
    let width = 0;
    let height = 0;
    let angle = 0.9;
    let last = performance.now();
    let frame = 0;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const draw = (now: number) => {
      const elapsed = Math.min(0.05, (now - last) / 1000);
      last = now;
      const activity = ACTIVITY[live.current.state];
      const calm = live.current.ambient ? 0.5 : 1;
      angle += activity.spin * calm * elapsed;

      // Turn every point around the vertical axis, tilt it slightly towards
      // the viewer, then project it with perspective.
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const tiltCos = Math.cos(0.2);
      const tiltSin = Math.sin(0.2);
      const scale = Math.min(width, height) * 0.5;
      for (let i = 0; i < points.length; i++) {
        const p = points[i] as Point;
        const x = p.x * cos + p.z * sin;
        const turnedZ = -p.x * sin + p.z * cos;
        const y = p.y * tiltCos - turnedZ * tiltSin;
        const z = p.y * tiltSin + turnedZ * tiltCos;
        const perspective = 2.8 / (2.8 - z);
        screenX[i] = width / 2 + x * scale * perspective;
        screenY[i] = height / 2 - y * scale * perspective;
        depth[i] = z;
      }

      context.clearRect(0, 0, width, height);

      // Connections and neurons, drawn far-to-near in a few depth bands so
      // the far side is fainter than the near side.
      for (let level = 0; level < DEPTH_LEVELS; level++) {
        const low = -1.1 + (2.2 * level) / DEPTH_LEVELS;
        const high = low + 2.2 / DEPTH_LEVELS;
        const nearness = (level + 1) / DEPTH_LEVELS;

        context.beginPath();
        for (const [a, b] of edges) {
          const z = ((depth[a] as number) + (depth[b] as number)) / 2;
          if (z < low || z >= high) continue;
          context.moveTo(screenX[a] as number, screenY[a] as number);
          context.lineTo(screenX[b] as number, screenY[b] as number);
        }
        context.strokeStyle = `rgba(146, 130, 176, ${0.04 + 0.2 * nearness})`;
        context.lineWidth = 0.6 + 0.5 * nearness;
        context.stroke();

        context.fillStyle = `rgba(236, 232, 226, ${0.16 + 0.62 * nearness})`;
        const size = 0.9 + 1.5 * nearness;
        for (let i = 0; i < points.length; i++) {
          const z = depth[i] as number;
          if (z < low || z >= high) continue;
          context.fillRect((screenX[i] as number) - size / 2, (screenY[i] as number) - size / 2, size, size);
        }
      }

      // Signals: small pale lights travelling along connections. Their
      // number is what makes "thinking" look different from "idle".
      if (Math.random() < activity.signals * calm * elapsed && signals.length < 90) {
        signals.push({ edge: Math.floor(Math.random() * edges.length), forward: Math.random() < 0.5, progress: 0, speed: 0.9 + Math.random() * 1.4 });
      }
      for (let i = signals.length - 1; i >= 0; i--) {
        const signal = signals[i] as Signal;
        signal.progress += signal.speed * elapsed;
        const [a, b] = edges[signal.edge] as [number, number];
        const from = signal.forward ? a : b;
        const to = signal.forward ? b : a;
        if (signal.progress >= 1) {
          // At the end of a connection the signal usually jumps to the next one.
          const next = links[to]?.filter((edge) => edge !== signal.edge) ?? [];
          if (next.length > 0 && Math.random() < 0.72) {
            const edge = next[Math.floor(Math.random() * next.length)] as number;
            signal.forward = (edges[edge] as [number, number])[0] === to;
            signal.edge = edge;
            signal.progress = 0;
          } else {
            signals.splice(i, 1);
          }
          continue;
        }
        const t = signal.progress;
        const x = (screenX[from] as number) * (1 - t) + (screenX[to] as number) * t;
        const y = (screenY[from] as number) * (1 - t) + (screenY[to] as number) * t;
        const nearness = (((depth[from] as number) + (depth[to] as number)) / 2 + 1.1) / 2.2;
        context.fillStyle = `rgba(241, 210, 198, ${0.1 + 0.16 * nearness})`;
        context.beginPath();
        context.arc(x, y, 5 + 4 * nearness, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = `rgba(241, 210, 198, ${0.5 + 0.5 * nearness})`;
        context.beginPath();
        context.arc(x, y, 1.2 + 1.2 * nearness, 0, Math.PI * 2);
        context.fill();
      }

      if (!reducedMotion) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [growth]);

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />;
}
