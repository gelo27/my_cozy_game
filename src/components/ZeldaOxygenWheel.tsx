import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { CharacterTelemetry } from '../character/CharacterController';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { OXYGEN_CONFIG } from '../config/constants';

interface ZeldaOxygenWheelProps {
  telemetry?: CharacterTelemetry;
  camera?: ThirdPersonCamera | null;
}

export const ZeldaOxygenWheel: React.FC<ZeldaOxygenWheelProps> = ({
  telemetry,
  camera,
}) => {
  const wheelContainerRef = useRef<HTMLDivElement>(null);

  const oxygen = telemetry?.oxygen ?? 100;
  const maxOxygen = telemetry?.maxOxygen ?? 100;
  const ratio = Math.max(0, Math.min(1, oxygen / maxOxygen));
  const isUnderwater = telemetry?.isUnderwater ?? false;
  const isSwimming = telemetry?.isSwimming ?? false;
  const isDrowning = telemetry?.isDrowning ?? false;
  const justRefilled = telemetry?.justRefilled ?? false;

  // The stamina wheel is visible whenever underwater, swimming with <100% oxygen, or during refill flash
  const shouldShow = isUnderwater || (isSwimming && ratio < 0.999) || ratio < 0.999 || justRefilled;

  // Compact Zelda Stamina Donut Wheel Geometry (~26px radius, ~52px diameter)
  const size = 56;
  const center = size / 2;
  const strokeWidth = 19; // Thick donut proportion matching Zelda BotW
  const radius = 17.5; // Center radius: outer = 27px, inner hole = 8px
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - ratio);

  // Status color determination
  const isLow = ratio <= OXYGEN_CONFIG.WARNING_THRESHOLD / 100;
  const isCritical = ratio <= OXYGEN_CONFIG.CRITICAL_THRESHOLD / 100;

  const activeColor = isCritical
    ? OXYGEN_CONFIG.CRITICAL_COLOR
    : isLow
    ? OXYGEN_CONFIG.WARNING_COLOR
    : OXYGEN_CONFIG.PRIMARY_COLOR;

  // 60FPS 3D-to-2D screen projection tracking: positioned above head with right offset
  useEffect(() => {
    let animId: number;

    const targetWorldPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    const vecToTarget = new THREE.Vector3();
    const camRight = new THREE.Vector3();
    const projected = new THREE.Vector3();

    const updatePosition = () => {
      if (wheelContainerRef.current && camera && camera.camera && telemetry?.position) {
        const charPos = telemetry.position;
        
        // Base position above character head (y + 0.8m)
        targetWorldPos.set(charPos.x, charPos.y + 0.8, charPos.z);

        const camPos = camera.camera.position;
        camera.camera.getWorldDirection(camDir);

        vecToTarget.copy(targetWorldPos).sub(camPos);
        const distance = vecToTarget.length();
        const distInFront = vecToTarget.dot(camDir);

        // Scale right offset proportionally with distance
        const rightOffset = Math.min(0.35, Math.max(0.12, distance * 0.08));

        // Offset to the right relative to camera view
        camRight.set(1, 0, 0).applyQuaternion(camera.camera.quaternion);
        camRight.y = 0;
        camRight.normalize();
        targetWorldPos.addScaledVector(camRight, rightOffset);

        if (distInFront > 0.25) {
          projected.copy(targetWorldPos).project(camera.camera);

          if (
            projected.z >= -1.0 &&
            projected.z <= 1.0 &&
            projected.x >= -1.15 &&
            projected.x <= 1.15 &&
            projected.y >= -1.15 &&
            projected.y <= 1.15
          ) {
            const width = window.innerWidth;
            const height = window.innerHeight;
            const screenX = (projected.x * 0.5 + 0.5) * width;
            const screenY = (-projected.y * 0.5 + 0.5) * height;

            wheelContainerRef.current.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) translate(-50%, -50%)`;
            wheelContainerRef.current.style.opacity = shouldShow ? '1' : '0';
          } else {
            wheelContainerRef.current.style.opacity = '0';
          }
        } else {
          wheelContainerRef.current.style.opacity = '0';
        }
      }
      animId = requestAnimationFrame(updatePosition);
    };

    updatePosition();
    return () => cancelAnimationFrame(animId);
  }, [camera, telemetry?.position, shouldShow]);

  return (
    <>
      {/* 1. Drowning Critical Screen Edge Vignette */}
      <div
        className={`fixed inset-0 pointer-events-none transition-opacity duration-300 z-10 ${
          isDrowning
            ? 'opacity-100'
            : isCritical && isUnderwater
            ? 'opacity-50'
            : 'opacity-0'
        }`}
        style={{
          background: isDrowning
            ? 'radial-gradient(ellipse at center, transparent 40%, rgba(255, 30, 60, 0.45) 85%, rgba(180, 0, 30, 0.8) 100%)'
            : 'radial-gradient(ellipse at center, transparent 55%, rgba(0, 255, 255, 0.25) 90%, rgba(0, 200, 255, 0.5) 100%)',
          boxShadow: isDrowning ? 'inset 0 0 100px rgba(255,0,0,0.6)' : 'none',
        }}
      />

      {/* 2. Floating Compact Zelda BotW Oxygen/Stamina Donut Wheel */}
      <div
        ref={wheelContainerRef}
        className="fixed top-0 left-0 pointer-events-none select-none z-30 transition-opacity duration-300"
        style={{
          opacity: 0,
          willChange: 'transform, opacity',
        }}
      >
        <div
          className={`relative flex items-center justify-center ${
            isCritical
              ? 'animate-pulse scale-105'
              : isLow
              ? 'animate-pulse'
              : justRefilled
              ? 'scale-110 transition-transform duration-300'
              : ''
          }`}
          style={{ width: `${size}px`, height: `${size}px` }}
        >
          <svg
            className="w-full h-full transform -rotate-90 block overflow-visible"
            viewBox={`0 0 ${size} ${size}`}
          >
            {/* Background unspent/depleted dark stamina ring */}
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="#132a2a"
              strokeWidth={strokeWidth}
            />

            {/* Active Stamina / Oxygen Progress Wheel with clean flat radial cut */}
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={justRefilled ? '#39ff14' : activeColor}
              strokeWidth={strokeWidth}
              strokeLinecap="butt"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              style={{
                transition: 'stroke-dashoffset 0.05s linear, stroke 0.2s ease',
              }}
            />
          </svg>
        </div>
      </div>
    </>
  );
};
