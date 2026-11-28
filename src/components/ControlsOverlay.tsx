import React, { useRef, useState, useEffect, useSyncExternalStore } from 'react';
import { ArrowUp, ArrowDown, Move, Hand, Footprints, Sparkles, LogOut, Octagon } from 'lucide-react';
import { InputManager } from '../input/InputManager';
import { t } from '../i18n/i18n';
import type { BulldozerController } from '../vehicle/BulldozerController';

interface ControlsOverlayProps {
  inputManager: InputManager | null;
  /** The character's live telemetry (read a few times a second: the dive button shows while swimming). */
  telemetry?: { isSwimming?: boolean } | null;
  bulldozer: BulldozerController;
}

export const ControlsOverlay: React.FC<ControlsOverlayProps> = ({ inputManager, telemetry, bulldozer }) => {
  const dozer = useSyncExternalStore(bulldozer.subscribe, bulldozer.getControls);
  const drivingDozer = dozer !== 'off';
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const joystickTouchIdRef = useRef<number | null>(null);
  const joystickOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [joystickCenterPos, setJoystickCenterPos] = useState<{ x: number; y: number } | null>(null);
  const [joystickThumbPos, setJoystickThumbPos] = useState({ x: 0, y: 0 });
  const [isJoystickActive, setIsJoystickActive] = useState(false);

  useEffect(() => {
    setIsTouchDevice('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }, []);

  // Swimming state for the dive button (telemetry is a mutable engine object, so it is polled)
  const [isSwimming, setIsSwimming] = useState(false);
  useEffect(() => {
    if (!isTouchDevice) return;
    const id = window.setInterval(() => setIsSwimming(!!telemetry?.isSwimming), 200);
    return () => window.clearInterval(id);
  }, [isTouchDevice, telemetry]);
  // Leaving the water while the button is held must not leave the dive stuck on
  useEffect(() => {
    if (!isSwimming && inputManager) inputManager.touchState.crouch = false;
  }, [isSwimming, inputManager]);

  /** Dive: held down = swim down (the same as holding C on a keyboard). */
  const setDive = (on: boolean) => (e: React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (inputManager) inputManager.touchState.crouch = on;
  };

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
    if (flag === 'interactJustPressed') inputManager.touchState.interactHeld = true;
    if (flag === 'chopJustPressed') inputManager.touchState.chopHeld = true;
  };
  /** Ends a hold on the E / use buttons. */
  const release = (flag: 'interactHeld' | 'chopHeld') => (e: React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (inputManager) inputManager.touchState[flag] = false;
  };
  const releaseJump = (e: React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (inputManager) inputManager.touchState.jump = false;
  };

  const roundBtn =
    'rounded-full bg-[#fffaf0]/92 text-[#4a3b2a] border-2 border-[#e9dcc3] shadow-[0_4px_14px_rgba(60,40,10,0.28)] flex items-center justify-center active:scale-90 transition-transform touch-none';
  const bladeAction = t(dozer === 'raised' ? 'dozer.lowerBlade' : 'dozer.raiseBlade');

  return (
    <div id="controls-overlay" className="absolute inset-0 pointer-events-none select-none z-25 overflow-hidden font-sans">
      {drivingDozer && (
        <div className="absolute bottom-28 short:bottom-20 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
          {dozer === 'blocked' && <span role="status" className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-950 text-center">{t('dozer.blocked')}</span>}
          {!isTouchDevice && (
            <div className="flex items-center gap-3 whitespace-nowrap rounded-full bg-[#fffaf0]/95 px-4 py-2 text-xs font-semibold text-[#4a3b2a] shadow-md">
              <span><kbd>WASD</kbd> {t('dozer.drive')}</span>
              <span><kbd>{t('dozer.bladeMouse')}</kbd> {bladeAction}</span>
              <span><kbd>Space</kbd> {t('dozer.brake')}</span>
              <span><kbd>E</kbd> {t('dozer.exit')}</span>
            </div>
          )}
        </div>
      )}
      {isTouchDevice && (
        <>
          {/* Floating joystick: touch anywhere in the lower-left area */}
          <div
            id="virtual-joystick-touch-zone"
            onTouchStart={handleLeftZoneTouchStart}
            onTouchMove={handleLeftZoneTouchMove}
            onTouchEnd={handleLeftZoneTouchEnd}
            onTouchCancel={handleLeftZoneTouchEnd}
            className="pointer-events-auto absolute bottom-20 short:bottom-14 [html[data-building]_&]:bottom-[150px] short:[html[data-building]_&]:bottom-[120px] [html[data-building]_&]:h-[45%] left-0 w-[45%] h-[55%] touch-none z-20"
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
              <div className="absolute bottom-4 left-6 short:bottom-1 short:left-4 w-20 h-20 rounded-full bg-[#fffaf0]/25 border-2 border-[#fffaf0]/60 flex items-center justify-center pointer-events-none">
                <Move className="w-6 h-6 text-white/80" />
              </div>
            )}
          </div>

          {/* Action cluster, kept above the hotbar */}
          {drivingDozer ? (
            <div className="pointer-events-auto absolute bottom-20 right-3 short:bottom-3 short:right-2 grid grid-cols-2 gap-2 justify-items-end">
              <button type="button" aria-label={t('dozer.exit')} onClick={() => {
                if (inputManager) inputManager.touchState.interactJustPressed = true;
              }} className={`${roundBtn} w-12 h-12`}>
                <LogOut className="w-5 h-5" />
              </button>
              <button type="button" aria-label={t('dozer.brake')} onTouchStart={tap('jumpJustPressed')}
                onTouchEnd={releaseJump} onTouchCancel={releaseJump} className={`${roundBtn} w-12 h-12`}>
                <Octagon className="w-5 h-5" />
              </button>
              <button type="button" aria-pressed={dozer !== 'raised'} onClick={() => {
                if (inputManager) inputManager.touchState.bladeToggleJustPressed = true;
              }} className={`${roundBtn} col-span-2 min-h-12 gap-1.5 px-3 text-xs font-semibold ${dozer !== 'raised' ? '!bg-amber-100' : ''}`}>
                {dozer === 'raised' ? <ArrowDown className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" />}
                {bladeAction}
              </button>
            </div>
          ) : (
          <div className="pointer-events-auto absolute bottom-20 right-3 short:bottom-3 short:right-2 [html[data-fishing]_&]:hidden [html[data-building]_&]:hidden grid grid-cols-2 gap-2 items-end select-none">
            <button
              onTouchStart={tap('interactJustPressed')}
              onTouchEnd={release('interactHeld')}
              onTouchCancel={release('interactHeld')}
              className={`${roundBtn} w-12 h-12`} title={t('touch.interact')}>
              <Hand className="w-5 h-5" />
            </button>
            <button
              onTouchStart={(e) => {
                e.stopPropagation();
                e.preventDefault();
                if (inputManager) inputManager.touchState.sprint = !inputManager.touchState.sprint;
              }}
              className={`${roundBtn} w-10 h-10 justify-self-end ${inputManager?.touchState.sprint ? '!bg-amber-400 !text-white !border-amber-300' : ''}`}
              title={t('touch.sprint')}
            >
              <Footprints className="w-4 h-4" />
            </button>
            <button
              onTouchStart={tap('chopJustPressed')}
              onTouchEnd={release('chopHeld')}
              onTouchCancel={release('chopHeld')}
              className={`${roundBtn} w-12 h-12`} title={t('touch.use')}>
              <Sparkles className="w-5 h-5" />
            </button>
            {isSwimming && (
              <button
                onTouchStart={setDive(true)}
                onTouchEnd={setDive(false)}
                onTouchCancel={setDive(false)}
                className={`${roundBtn} w-12 h-12 !bg-sky-500 !text-white !border-sky-300`}
                title={t('touch.dive')}
              >
                <ArrowDown className="w-6 h-6" />
              </button>
            )}
            <button
              onTouchStart={tap('jumpJustPressed')}
              onTouchEnd={releaseJump}
              onTouchCancel={releaseJump}
              className={`${roundBtn} w-14 h-14 !bg-emerald-500 !text-white !border-emerald-300`}
              title={t('touch.jump')}
            >
              <ArrowUp className="w-7 h-7" />
            </button>
          </div>
          )}
        </>
      )}
    </div>
  );
};
