/**
 * Every full-screen UI of the game, and the rule between them: one at a time.
 *
 * - inventory, map: React state in App;
 * - build, paint: BuildAbility's modes;
 * - panel: GameplayManager's panels (cooking, shop, storage, farmhands, the worker's radial menu);
 * - pause: the pause menu; editor: the dev editor.
 *
 * Each owner registers how to tell whether its screen is open and how to close it; every opener asks
 * `request(id)` first. Opening a screen closes whatever else is open (the backpack over the build
 * mode, the map over a shop...), the way games switch between their menus. Some states refuse any
 * new screen: the pause menu and the editor stay on top until left, and nothing opens while the
 * player sleeps or a doorway fade plays.
 */
export type UiScreen = 'inventory' | 'map' | 'build' | 'paint' | 'panel' | 'pause' | 'editor';

interface ScreenHooks {
  isOpen(): boolean;
  close(): void;
}

class UiScreensImpl {
  private readonly screens = new Map<UiScreen, ScreenHooks>();
  /** True while no screen may open (asleep, a doorway fade) */
  private blocked: () => boolean = () => false;

  /** Registers a screen's owner; returns the unregister function. */
  public register(id: UiScreen, hooks: ScreenHooks): () => void {
    this.screens.set(id, hooks);
    return () => {
      if (this.screens.get(id) === hooks) this.screens.delete(id);
    };
  }

  public setBlocked(fn: () => boolean): void {
    this.blocked = fn;
  }

  public isOpen(id: UiScreen): boolean {
    return !!this.screens.get(id)?.isOpen();
  }

  /** The open screen, null while just playing. The pause menu and the editor come first. */
  public get current(): UiScreen | null {
    if (this.isOpen('editor')) return 'editor';
    if (this.isOpen('pause')) return 'pause';
    for (const [id, s] of this.screens) if (s.isOpen()) return id;
    return null;
  }

  /**
   * Asks to open `id`: closes every other open screen and says yes, or says no (and closes nothing)
   * while the pause menu or the editor is up, or while blocked. Asking for an open screen is a yes.
   */
  public request(id: UiScreen): boolean {
    if (this.isOpen(id)) return true;
    if (id !== 'editor' && this.isOpen('editor')) return false;
    if (id !== 'pause' && this.isOpen('pause')) return false;
    if (id !== 'pause' && id !== 'editor' && this.blocked()) return false;
    for (const [other, s] of this.screens) {
      if (other !== id && other !== 'editor' && s.isOpen()) s.close();
    }
    return true;
  }
}

export const uiScreens = new UiScreensImpl();
