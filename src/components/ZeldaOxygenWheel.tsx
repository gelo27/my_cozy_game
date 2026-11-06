import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { CharacterTelemetry } from '../character/CharacterController';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { OXYGEN_CONFIG } from '../config/constants';

interface ZeldaOxygenWheelProps {
  telemetry?: CharacterTelemetry;
  camera?: ThirdPersonCamera | null;
}

const SIZE = 34;
const STROKE = 5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * RADIUS;

/**
 * Small circular air gauge next to the character's head (upper right of it).
 * Shown only while underwater / refilling. Driven by rAF straight from the telemetry
 * object (no React re-render per frame) and never captures the pointer.
 */
export const ZeldaOxygenWheel: React.FC<ZeldaOxygenWheelProps> = ({ telemetry, camera }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const arcRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    let id = 0;
    const world = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const right = new THREE.Vector3();
    let shownUntil = 0;
    // Smoothed screen position: the swimming body bobs every frame, the gauge should glide
    let sx = NaN, sy = NaN;
    let last = performance.now();

    const tick = () => {
      id = requestAnimationFrame(tick);
      const box = boxRef.current, arc = arcRef.current, cam = camera?.camera;
      if (!box || !arc || !cam || !telemetry?.position) return;

      const ratio = Math.max(0, Math.min(1, (telemetry.oxygen ?? 100) / (telemetry.maxOxygen || 100)));
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (telemetry.isUnderwater || ratio < 0.999 || telemetry.justRefilled) shownUntil = now + 600;
      let visible = now < shownUntil;

      if (visible) {
        // Upper right of the head, offset to the camera's right
        const p = telemetry.position;
        world.set(p.x, p.y + 1.0, p.z);
        cam.getWorldDirection(dir);
        const dist = world.distanceTo(cam.position);
        right.set(1, 0, 0).applyQuaternion(cam.quaternion);
        right.y = 0;
        right.normalize();
        world.addScaledVector(right, Math.min(0.55, Math.max(0.25, dist * 0.1)));
        world.y += Math.min(0.3, dist * 0.05);
        const inFront = dir.dot(world.clone().sub(cam.position));
        world.project(cam);
        visible = inFront > 0.25 && Math.abs(world.x) < 1.1 && Math.abs(world.y) < 1.1;
        if (visible) {
          const x = (world.x * 0.5 + 0.5) * window.innerWidth;
          const y = (-world.y * 0.5 + 0.5) * window.innerHeight;
          // Snap when it first shows or jumps far (camera cut), otherwise ease toward the head
          if (Number.isNaN(sx) || Math.hypot(x - sx, y - sy) > 160) {
            sx = x;
            sy = y;
          } else {
            const k = 1 - Math.exp(-dt * 7);
            sx += (x - sx) * k;
            sy += (y - sy) * k;
          }
          box.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -50%)`;
        }
      }
      if (!visible) sx = sy = NaN;
      box.style.opacity = visible ? '1' : '0';

      const critical = ratio <= OXYGEN_CONFIG.CRITICAL_THRESHOLD / 100;
      const low = ratio <= OXYGEN_CONFIG.WARNING_THRESHOLD / 100;
      arc.style.strokeDashoffset = String(CIRC * (1 - ratio));
      arc.style.stroke = telemetry.justRefilled
        ? '#7dffb0'
        : critical
        ? OXYGEN_CONFIG.CRITICAL_COLOR
        : low
        ? OXYGEN_CONFIG.WARNING_COLOR
        : '#4cc2ff';
      // A slow, small pulse when air is almost out (no fast shaking)
      box.style.scale = critical ? (1 + 0.04 * Math.sin(now / 220)).toFixed(3) : '1';
    };
    tick();
    return () => cancelAnimationFrame(id);
  }, [camera, telemetry]);

  return (
    <div
      ref={boxRef}
      className="fixed top-0 left-0 pointer-events-none select-none z-30"
      style={{ opacity: 0, transition: 'opacity 0.25s', willChange: 'transform, opacity' }}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="block -rotate-90 overflow-visible">
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="rgba(8,30,48,0.35)" stroke="rgba(10,40,60,0.55)" strokeWidth={STROKE} />
        <circle
          ref={arcRef}
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="#4cc2ff"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={0}
        />
      </svg>
    </div>
  );
};
