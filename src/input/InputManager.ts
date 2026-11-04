import * as THREE from 'three';

export interface MovementInput {
  forward: number; // -1 to 1
  right: number;   // -1 to 1
  jump: boolean;
  jumpJustPressed: boolean;
  sprint: boolean;
  crouch: boolean;
  dash: boolean;
  reset: boolean;
  interact: boolean;
  interactJustPressed: boolean;
  weapon1JustPressed: boolean;
  weapon2JustPressed: boolean;
  weapon3JustPressed: boolean;
  weapon4JustPressed: boolean;
  weapon5JustPressed: boolean;
  weapon6JustPressed: boolean;
  weapon7JustPressed: boolean;
  weapon8JustPressed: boolean;
  weapon9JustPressed: boolean;
  reload: boolean;
  reloadJustPressed: boolean;
  aim: boolean;
  shoot: boolean;
  shootJustPressed: boolean;
  buildToggleJustPressed: boolean;
  buildRotateJustPressed: boolean;
  buildSnapToggleJustPressed: boolean;
  buildDemolishJustPressed: boolean;
  buildPlaceJustPressed: boolean;
  paintToggleJustPressed: boolean;
  terrainToggleJustPressed: boolean;
  inventoryToggleJustPressed: boolean;
  buildSelectSlot?: number;
  mouseNDC?: THREE.Vector2;
  isPointerLocked?: boolean;
  isDragging?: boolean;
  isMouseDown?: boolean;
  isMouseDownJustPressed?: boolean;
  keys?: Record<string, boolean>;
}

export class InputManager {
  public movement: MovementInput = {
    forward: 0,
    right: 0,
    jump: false,
    jumpJustPressed: false,
    sprint: false,
    crouch: false,
    dash: false,
    reset: false,
    interact: false,
    interactJustPressed: false,
    weapon1JustPressed: false,
    weapon2JustPressed: false,
    weapon3JustPressed: false,
    weapon4JustPressed: false,
    weapon5JustPressed: false,
    weapon6JustPressed: false,
    weapon7JustPressed: false,
    weapon8JustPressed: false,
    weapon9JustPressed: false,
    reload: false,
    reloadJustPressed: false,
    aim: false,
    shoot: false,
    shootJustPressed: false,
    buildToggleJustPressed: false,
    buildRotateJustPressed: false,
    buildSnapToggleJustPressed: false,
    buildDemolishJustPressed: false,
    buildPlaceJustPressed: false,
    paintToggleJustPressed: false,
    terrainToggleJustPressed: false,
    inventoryToggleJustPressed: false,
    mouseNDC: new THREE.Vector2(0, 0),
    isPointerLocked: false,
    isDragging: false,
  };

  public mouseDelta = new THREE.Vector2();
  public mouseScroll: number = 0;
  public isPointerLocked: boolean = false;
  public mouseNDC = new THREE.Vector2(0, 0);
  public isDragging: boolean = false;
  public isBuildMode: boolean = false;
  public isPaintMode: boolean = false;
  public isTerrainMode: boolean = false;
  public isInventoryOpen: boolean = false;

  public isMouseDown: boolean = false;
  public isRightMouseDown: boolean = false;
  private isMouseDownPrevious: boolean = false;
  private mouseDownTime: number = 0;
  private dragDistance: number = 0;
  private lastMouseX: number = 0;
  private lastMouseY: number = 0;
  public startedOnUI: boolean = false;
  private mouseBuildPlaceJustPressed: boolean = false;
  private mouseBuildDemolishJustPressed: boolean = false;

  private keys: Record<string, boolean> = {};
  private previousKeys: Record<string, boolean> = {};
  private element: HTMLElement;

  // Touch state
  public touchJoystickActive: boolean = false;
  public touchJoystickVector = new THREE.Vector2();

  public touchState = {
    jump: false,
    jumpJustPressed: false,
    sprint: false,
    crouch: false,
    dashJustPressed: false,
    interactJustPressed: false,
    /** Touch E / use buttons currently held (for hold-to-act, e.g. the shovel). */
    interactHeld: false,
    chopJustPressed: false,
    chopHeld: false,
    buildToggleJustPressed: false,
    buildRotateJustPressed: false,
    buildSnapToggleJustPressed: false,
    buildDemolishJustPressed: false,
    buildPlaceJustPressed: false,
    buildSelectSlot: undefined as number | undefined,
  };

  private cameraTouchId: number | null = null;
  private lastTouchX = 0;
  private lastTouchY = 0;

  constructor(element: HTMLElement) {
    this.element = element;
    this.setupListeners();
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    this.keys[e.code] = true;
  };

  private handleKeyUp = (e: KeyboardEvent) => {
    this.keys[e.code] = false;
  };

  private handleMouseDown = (e: MouseEvent) => {
    // If clicking on UI buttons or inputs, do not handle canvas dragging
    const target = e.target as HTMLElement | null;
    if (target && target.closest('button, [role="button"], input, select, textarea, .pointer-events-auto')) {
      this.startedOnUI = true;
      return;
    }
    this.startedOnUI = false;

    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    this.dragDistance = 0;
    this.isDragging = false;
    this.mouseDownTime = performance.now();

    if (e.button === 0) {
      this.isMouseDown = true;
    } else if (e.button === 2) {
      this.isRightMouseDown = true;
    }
  };

  private handleMouseUp = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const isUI = this.startedOnUI || (target && target.closest('button, [role="button"], input, select, textarea, .pointer-events-auto'));
    const clickDuration = performance.now() - this.mouseDownTime;
    const isDragGesture = this.isDragging || this.dragDistance > 6 || clickDuration > 450;

    if (e.button === 0) {
      if ((this.isBuildMode || this.isPaintMode) && !isDragGesture && !isUI) {
        this.mouseBuildPlaceJustPressed = true;
      }
      this.isMouseDown = false;
    } else if (e.button === 2) {
      if ((this.isBuildMode || this.isPaintMode) && !isDragGesture && !isUI) {
        this.mouseBuildDemolishJustPressed = true;
      }
      this.isRightMouseDown = false;
    }

    if (!this.isMouseDown && !this.isRightMouseDown) {
      this.isDragging = false;
      this.dragDistance = 0;
      this.startedOnUI = false;
    }
  };

  private handlePointerLockChange = () => {
    this.isPointerLocked = document.pointerLockElement === this.element;
    if (this.isPointerLocked && (this.isPaintMode || this.isBuildMode)) {
      this.exitPointerLock();
    }
  };

  private handlePointerLockError = () => {
    this.isPointerLocked = false;
  };

  private handleMouseMove = (e: MouseEvent) => {
    const rect = this.element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    }

    let dx = 0;
    let dy = 0;

    const canRotateCamera = (!this.isPaintMode && !this.isTerrainMode) || this.isRightMouseDown;

    if (this.isPointerLocked) {
      if (this.isPaintMode || this.isBuildMode || this.isTerrainMode) {
        this.exitPointerLock();
      }
      dx = e.movementX;
      dy = e.movementY;
      if (canRotateCamera) {
        this.mouseDelta.x += dx;
        this.mouseDelta.y += dy;
      }
      if (this.isMouseDown || this.isRightMouseDown) {
        this.dragDistance += Math.hypot(dx, dy);
        if (this.dragDistance > 6) {
          this.isDragging = true;
        }
      }
    } else {
      dx = e.clientX - this.lastMouseX;
      dy = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      if (this.isMouseDown || this.isRightMouseDown) {
        if (canRotateCamera) {
          this.mouseDelta.x += dx;
          this.mouseDelta.y += dy;
        }
        this.dragDistance += Math.hypot(dx, dy);
        if (this.dragDistance > 6) {
          this.isDragging = true;
        }
      }
    }
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.mouseScroll += Math.sign(e.deltaY) * 0.5;
  };

  private updateTouchNDC(touch: Touch) {
    const rect = this.element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.mouseNDC.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouseNDC.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
    }
  }

  private handleTouchStart = (e: TouchEvent) => {
    if (e.changedTouches.length > 0) {
      this.updateTouchNDC(e.changedTouches[0]);
    }

    if (this.cameraTouchId === null) {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.clientX > window.innerWidth * 0.5) {
          this.cameraTouchId = touch.identifier;
          this.lastTouchX = touch.clientX;
          this.lastTouchY = touch.clientY;
          break;
        }
      }
    }
  };

  private handleTouchMove = (e: TouchEvent) => {
    if (e.changedTouches.length > 0) {
      this.updateTouchNDC(e.changedTouches[0]);
    }

    if (this.cameraTouchId === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === this.cameraTouchId) {
        const dx = touch.clientX - this.lastTouchX;
        const dy = touch.clientY - this.lastTouchY;
        this.mouseDelta.x += dx * 4.2;
        this.mouseDelta.y += dy * 4.2;
        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;
        break;
      }
    }
  };

  private handleTouchEnd = (e: TouchEvent) => {
    if (e.changedTouches.length > 0) {
      this.updateTouchNDC(e.changedTouches[0]);
    }

    if (this.cameraTouchId === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === this.cameraTouchId) {
        this.cameraTouchId = null;
        break;
      }
    }
  };

  private setupListeners(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('pointerlockerror', this.handlePointerLockError);

    this.element.addEventListener('mousedown', this.handleMouseDown);
    this.element.addEventListener('wheel', this.handleWheel, { passive: false });
    this.element.addEventListener('touchstart', this.handleTouchStart, { passive: true });
    this.element.addEventListener('touchmove', this.handleTouchMove, { passive: true });
    this.element.addEventListener('touchend', this.handleTouchEnd);
    this.element.addEventListener('touchcancel', this.handleTouchEnd);
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('contextmenu', (e) => e.preventDefault());
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('pointerlockerror', this.handlePointerLockError);

    this.element.removeEventListener('mousedown', this.handleMouseDown);
    this.element.removeEventListener('wheel', this.handleWheel);
    this.element.removeEventListener('touchstart', this.handleTouchStart);
    this.element.removeEventListener('touchmove', this.handleTouchMove);
    this.element.removeEventListener('touchend', this.handleTouchEnd);
    this.element.removeEventListener('touchcancel', this.handleTouchEnd);
  }

  public setBuildMode(active: boolean): void {
    if (this.isBuildMode !== active) {
      this.isBuildMode = active;
      if (active) {
        this.exitPointerLock();
      } else if (!this.isPaintMode) {
        this.requestPointerLock();
      }
    }
  }

  public setPaintMode(active: boolean): void {
    if (this.isPaintMode !== active) {
      this.isPaintMode = active;
      if (active) {
        this.exitPointerLock();
      } else if (!this.isBuildMode && !this.isTerrainMode) {
        this.requestPointerLock();
      }
    } else if (active && (document.pointerLockElement || this.isPointerLocked)) {
      this.exitPointerLock();
    }
  }

  public setTerrainMode(active: boolean): void {
    if (this.isTerrainMode !== active) {
      this.isTerrainMode = active;
      if (active) {
        this.exitPointerLock();
      } else if (!this.isBuildMode && !this.isPaintMode) {
        this.requestPointerLock();
      }
    } else if (active && (document.pointerLockElement || this.isPointerLocked)) {
      this.exitPointerLock();
    }
  }

  public setInventoryMode(active: boolean): void {
    if (this.isInventoryOpen !== active) {
      this.isInventoryOpen = active;
      if (active) {
        this.exitPointerLock();
      } else if (!this.isBuildMode && !this.isPaintMode && !this.isTerrainMode) {
        this.requestPointerLock();
      }
    }
  }

  public requestPointerLock(): void {
    if (this.isBuildMode || this.isPaintMode || this.isTerrainMode || this.isInventoryOpen) return; // Cursor stays unlocked in build, paint, terrain, and inventory modes
    if (document.pointerLockElement === this.element) return;
    try {
      const res = this.element.requestPointerLock?.() as unknown;
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch(() => {
          // Gracefully swallow pointer lock acquisition failure
        });
      }
    } catch {
      // Gracefully swallow synchronous pointer lock exceptions
    }
  }

  public exitPointerLock(): void {
    this.isPointerLocked = false;
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock?.();
      } catch {
        // Gracefully swallow exit exceptions
      }
    }
  }

  public update(): void {
    // Keyboard axes
    let forward = 0;
    let right = 0;

    if (this.keys['KeyW'] || this.keys['ArrowUp']) forward += 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) forward -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) right += 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) right -= 1;

    // Virtual Touch Joystick override if active
    if (this.touchJoystickActive) {
      forward = this.touchJoystickVector.y;
      right = this.touchJoystickVector.x;
    }

    const jumpDown = !!this.keys['Space'] || this.touchState.jump;
    const jumpJustPressed = (!!this.keys['Space'] && !this.previousKeys['Space']) || this.touchState.jumpJustPressed;

    const dashDown = !!(this.keys['ControlLeft'] || this.keys['KeyZ']) || this.touchState.dashJustPressed;
    const dashJustPressed = (dashDown && !(this.previousKeys['ControlLeft'] || this.previousKeys['KeyZ'])) || this.touchState.dashJustPressed;

    const inventoryToggleJustPressed = (!!this.keys['KeyQ'] && !this.previousKeys['KeyQ']) || (this.touchState as any).inventoryToggleJustPressed;

    const resetDown = !!this.keys['KeyR'];
    const resetJustPressed = resetDown && !this.previousKeys['KeyR'];

    // Touch buttons report "held" separately so holding one doesn't re-fire the just-pressed edge
    const interactKeyDown = !!(this.keys['KeyE'] || this.keys['KeyF']);
    const interactDown = interactKeyDown || this.touchState.interactHeld;
    const interactJustPressed = (interactKeyDown && !(this.previousKeys['KeyE'] || this.previousKeys['KeyF'])) || this.touchState.interactJustPressed;

    const weapon1JustPressed = !!this.keys['Digit1'] && !this.previousKeys['Digit1'];
    const weapon2JustPressed = !!this.keys['Digit2'] && !this.previousKeys['Digit2'];
    const weapon3JustPressed = !!this.keys['Digit3'] && !this.previousKeys['Digit3'];
    const weapon4JustPressed = !!this.keys['Digit4'] && !this.previousKeys['Digit4'];
    const weapon5JustPressed = !!this.keys['Digit5'] && !this.previousKeys['Digit5'];
    const weapon6JustPressed = (!!this.keys['Digit6'] && !this.previousKeys['Digit6']) || (!!this.keys['KeyX'] && !this.previousKeys['KeyX']) || this.touchState.chopJustPressed;
    const weapon7JustPressed = !!this.keys['Digit7'] && !this.previousKeys['Digit7'];
    const weapon8JustPressed = !!this.keys['Digit8'] && !this.previousKeys['Digit8'];
    const weapon9JustPressed = !!this.keys['Digit9'] && !this.previousKeys['Digit9'];
    
    const reloadDown = !!this.keys['KeyR'];
    const reloadJustPressed = reloadDown && !this.previousKeys['KeyR'];

    const shootDown = this.isMouseDown || this.touchState.chopJustPressed || this.touchState.chopHeld;
    const shootJustPressed = (this.isMouseDown && !this.isMouseDownPrevious) || this.touchState.chopJustPressed;

    const buildToggleJustPressed = (!!this.keys['KeyB'] && !this.previousKeys['KeyB']) || this.touchState.buildToggleJustPressed;
    const buildRotateJustPressed = (!!this.keys['KeyR'] && !this.previousKeys['KeyR']) || this.touchState.buildRotateJustPressed;
    const buildSnapToggleJustPressed = (!!this.keys['KeyV'] && !this.previousKeys['KeyV']) || this.touchState.buildSnapToggleJustPressed;
    const buildDemolishJustPressed = (!!this.keys['KeyX'] && !this.previousKeys['KeyX']) || this.touchState.buildDemolishJustPressed || this.mouseBuildDemolishJustPressed;
    const buildPlaceJustPressed = this.touchState.buildPlaceJustPressed || this.mouseBuildPlaceJustPressed;
    const paintToggleJustPressed = (!!this.keys['KeyP'] && !this.previousKeys['KeyP']) || (this.touchState as any).paintToggleJustPressed;
    const terrainToggleJustPressed = (!!this.keys['KeyT'] && !this.previousKeys['KeyT']);
    const buildSelectSlot = this.touchState.buildSelectSlot;

    this.movement = {
      forward,
      right,
      jump: jumpDown,
      jumpJustPressed,
      sprint: !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']) || this.touchState.sprint,
      crouch: !!(this.keys['KeyC'] || this.keys['ControlLeft'] || this.keys['ControlRight']) || this.touchState.crouch,
      dash: dashJustPressed,
      reset: false, // Disabling old reset on R
      interact: interactDown,
      interactJustPressed,
      weapon1JustPressed,
      weapon2JustPressed,
      weapon3JustPressed,
      weapon4JustPressed,
      weapon5JustPressed,
      weapon6JustPressed,
      weapon7JustPressed,
      weapon8JustPressed,
      weapon9JustPressed,
      reload: reloadDown,
      reloadJustPressed,
      aim: this.isRightMouseDown,
      shoot: shootDown,
      shootJustPressed,
      buildToggleJustPressed,
      buildRotateJustPressed,
      buildSnapToggleJustPressed,
      buildDemolishJustPressed,
      buildPlaceJustPressed,
      paintToggleJustPressed,
      terrainToggleJustPressed,
      inventoryToggleJustPressed,
      buildSelectSlot,
      mouseNDC: this.mouseNDC.clone(),
      isPointerLocked: this.isPointerLocked,
      isDragging: this.isDragging,
      isMouseDown: this.isMouseDown,
      isMouseDownJustPressed: this.isMouseDown && !this.isMouseDownPrevious,
      keys: { ...this.keys },
    };

    // Clear single-frame triggers after movement state assignment
    this.touchState.jumpJustPressed = false;
    this.touchState.dashJustPressed = false;
    this.touchState.interactJustPressed = false;
    this.touchState.chopJustPressed = false;
    this.touchState.buildToggleJustPressed = false;
    this.touchState.buildRotateJustPressed = false;
    this.touchState.buildSnapToggleJustPressed = false;
    this.touchState.buildDemolishJustPressed = false;
    this.touchState.buildPlaceJustPressed = false;
    (this.touchState as any).paintToggleJustPressed = false;
    this.touchState.buildSelectSlot = undefined;
    this.mouseBuildPlaceJustPressed = false;
    this.mouseBuildDemolishJustPressed = false;

    // Store previous key states for single-frame trigger detection
    this.previousKeys = { ...this.keys };
    this.isMouseDownPrevious = this.isMouseDown;
  }

  public consumeMouseDelta(): THREE.Vector2 {
    const delta = this.mouseDelta.clone();
    this.mouseDelta.set(0, 0);
    return delta;
  }

  public consumeMouseScroll(): number {
    const scroll = this.mouseScroll;
    this.mouseScroll = 0;
    return scroll;
  }
}
