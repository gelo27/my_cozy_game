import React, { useRef, useState, useEffect } from 'react';
import { ArrowUp, Move, Hand, Footprints, Sparkles } from 'lucide-react';
import { InputManager } from '../input/InputManager';

interface ControlsOverlayProps {
  inputManager: InputManager | null;
}

export const ControlsOverlay: React.FC<ControlsOverlayProps> = ({ inputManager }) => {
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const joystickTouchIdRef = useRef<number | null>(null);
  const joystickOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [joystickCenterPos, setJoystickCenterPos] = useState<{ x: number; y: number } | null>(null);
  const [joystickThumbPos, setJoystickThumbPos] = useState({ x: 0, y: 0 });
  const [isJoystickActive, setIsJoystickActive] = useState(false);

  useEffect(() => {
    setIsTouchDevice('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }, []);

  // Touch joystick handling anywhere on the left half of the screen
  const handleLeftZoneTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (!inputManager) return;
    if (joystickTouchIdRef.current === null && e.changedTouches.length > 0) {
      const touch = e.changedTouches[0];
      joystickTouchIdRef.current = touch.identifier;
      joystickOriginRef.current = { x: touch.clientX, y: touch.clientY };
      setJoystickCenterPos({ x: touch.clientX, y: touch.clientY });
      setIsJoystickActive(true);
      inputManager.touchJoystickActive = true;
      updateJoystickPos(touch, touch.clientX, touch.clientY);
    }
  };

  const handleLeftZoneTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (!inputManager || !inputManager.touchJoystickActive || joystickTouchIdRef.current === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === joystickTouchIdRef.current) {
        updateJoystickPos(touch, joystickOriginRef.current.x, joystickOriginRef.current.y);
        break;
      }
    }
  };

  const handleLeftZoneTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (joystickTouchIdRef.current === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === joystickTouchIdRef.current) {
        joystickTouchIdRef.current = null;
        if (inputManager) {
          inputManager.touchJoystickActive = false;
          inputManager.touchJoystickVector.set(0, 0);
        }
        setIsJoystickActive(false);
        setJoystickThumbPos({ x: 0, y: 0 });
        break;
      }
    }
  };

  const updateJoystickPos = (touch: React.Touch, originX: number, originY: number) => {
    if (!inputManager) return;
    const dx = touch.clientX - originX;
    const dy = touch.clientY - originY;
    const maxRadius = 48; // max drag radius in pixels

    const distance = Math.sqrt(dx * dx + dy * dy);
    const clampedDist = Math.min(distance, maxRadius);
    const angle = Math.atan2(dy, dx);

    const thumbX = Math.cos(angle) * clampedDist;
    const thumbY = Math.sin(angle) * clampedDist;

    setJoystickThumbPos({ x: thumbX, y: thumbY });

    // Normalized input vector: -Y is forward in screen space, so invert Y
    const normX = thumbX / maxRadius;
    const normY = -thumbY / maxRadius;
    inputManager.touchJoystickVector.set(normX, normY);
  };

  /** Momentary touch button: sets a one-frame flag on the input manager. */
  const tap = (flag: 'jumpJustPressed' | 'interactJustPressed' | 'chopJustPressed') => (e: React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!inputManager) return;
    inputManager.touchState[flag] = true;
    if (flag === 'jumpJustPressed') inputManager.touchState.jump = true;
  };
  const releaseJump = (e: React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (inputManager) inputManager.touchState.jump = false;
  };

  const roundBtn =
    'rounded-full bg-[#fffaf0]/92 text-[#4a3b2a] border-2 border-[#e9dcc3] shadow-[0_4px_14px_rgba(60,40,10,0.28)] flex items-center justify-center active:scale-90 transition-transform touch-none';

  return (
    <div id="controls-overlay" className="absolute inset-0 pointer-events-none select-none z-25 overflow-hidden font-sans">
      {isTouchDevice && (
        <>
          {/* Floating joystick: touch anywhere in the lower-left area */}
          <div
            id="virtual-joystick-touch-zone"
            onTouchStart={handleLeftZoneTouchStart}
            onTouchMove={handleLeftZoneTouchMove}
            onTouchEnd={handleLeftZoneTouchEnd}
            onTouchCancel={handleLeftZoneTouchEnd}
            className="pointer-events-auto absolute bottom-20 left-0 w-[45%] h-[55%] touch-none z-20"
          >
            {isJoystickActive && joystickCenterPos ? (
              <div
                className="fixed w-28 h-28 rounded-full bg-[#fffaf0]/35 border-2 border-[#fffaf0]/80 flex items-center justify-center pointer-events-none -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${joystickCenterPos.x}px`, top: `${joystickCenterPos.y}px` }}
              >
                <div
                  className="w-12 h-12 rounded-full bg-[#fffaf0] border-2 border-[#e9dcc3] shadow-lg pointer-events-none"
                  style={{ transform: `translate(${joystickThumbPos.x}px, ${joystickThumbPos.y}px)` }}
                />
              </div>
            ) : (
              <div className="absolute bottom-4 left-6 w-24 h-24 rounded-full bg-[#fffaf0]/25 border-2 border-[#fffaf0]/60 flex items-center justify-center pointer-events-none">
                <Move className="w-7 h-7 text-white/80" />
              </div>
            )}
          </div>

          {/* Action cluster, kept above the hotbar */}
          <div className="pointer-events-auto absolute bottom-24 right-3 grid grid-cols-2 gap-2.5 items-end select-none">
            <button onTouchStart={tap('interactJustPressed')} className={`${roundBtn} w-14 h-14`} title="Взаємодія (E)">
              <Hand className="w-6 h-6" />
            </button>
            <button
              onTouchStart={(e) => {
                e.stopPropagation();
                e.preventDefault();
                if (inputManager) inputManager.touchState.sprint = !inputManager.touchState.sprint;
              }}
              className={`${roundBtn} w-12 h-12 justify-self-end ${inputManager?.touchState.sprint ? '!bg-amber-400 !text-white !border-amber-300' : ''}`}
              title="Біг"
            >
              <Footprints className="w-5 h-5" />
            </button>
            <button onTouchStart={tap('chopJustPressed')} className={`${roundBtn} w-14 h-14`} title="Використати інструмент">
              <Sparkles className="w-6 h-6" />
            </button>
            <button
              onTouchStart={tap('jumpJustPressed')}
              onTouchEnd={releaseJump}
              onTouchCancel={releaseJump}
              className={`${roundBtn} w-16 h-16 !bg-emerald-500 !text-white !border-emerald-300`}
              title="Стрибок"
            >
              <ArrowUp className="w-8 h-8" />
            </button>
          </div>
        </>
      )}
    </div>
  );
};
