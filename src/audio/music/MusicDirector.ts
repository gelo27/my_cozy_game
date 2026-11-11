import { audioEngine } from '../AudioEngine';
import { isMobileDevice } from '../../world/WorldSettings';
import { userSettings } from '../../config/userSettings';
import { InstrumentBank } from './InstrumentBank';
import { LOOKAHEAD_DESKTOP, LOOKAHEAD_MOBILE, SongPlayer, VoicePool } from './MusicEngine';
import { findSongs, getSong, songIds } from './library';
import type { CompiledSong } from './SongFormat';

/** What the director reads from the world every frame. */
export interface MusicWorldState {
  /** Hours, 0..24. */
  timeOfDay: number;
  /** 0 day .. 1 night. */
  night: number;
  /** Weather type id ('clear', 'rain', ...). */
  weather: string;
  /** 0..1 rain loudness. */
  rain: number;
  inCave: boolean;
  underwater: boolean;
  sleeping: boolean;
  /** 0 nothing, 1 an enemy is after the player, 2 it is attacking / close. */
  threat: number;
}

type Mode = 'ambient' | 'cave' | 'danger' | 'sleep';
export type TimeSlot = 'day' | 'evening' | 'night';

/** Weather that may borrow another weather's tracks while it has none of its own. */
const WEATHER_FALLBACK: Record<string, string> = { cloudy: 'clear' };

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Decides what music plays, in priority order: the danger loop while an enemy is after the player,
 * short stingers for achievements, rare quiet motifs underground (no soundtrack in caves), and
 * otherwise a track for the time of day and weather, with long silences between tracks.
 *
 * A track is never cut mid-phrase when the weather turns: it finishes its section and fades.
 */
class MusicDirector {
  private ctx: AudioContext | null = null;
  private bank: InstrumentBank | null = null;
  private pool: VoicePool | null = null;
  /** Tracks, loops and motifs (ducked under stingers and underwater). */
  private duck: GainNode | null = null;
  private stingerBus: GainNode | null = null;
  private wetSend: GainNode | null = null;
  private timer = 0;
  private lookahead = isMobileDevice() ? LOOKAHEAD_MOBILE : LOOKAHEAD_DESKTOP;

  private mode: Mode = 'ambient';
  private track: SongPlayer | null = null;
  private danger: SongPlayer | null = null;
  private motif: SongPlayer | null = null;
  private readonly stingers: SongPlayer[] = [];
  private loading = false;
  /** Seconds of silence left before the next track (game time, frozen while paused). */
  private silence = rand(8, 20);
  private moodEnded = false;
  private motifIn = rand(40, 90);
  private dangerHold = 0;
  private readonly history: string[] = [];
  private readonly stingerCooldown = new Map<string, number>();
  private lastStingerAt = -999;
  private clock = 0;
  private lastUpdateMs = 0;
  private duckUntil = 0;
  private lastMotif = '';
  private state: MusicWorldState | null = null;
  /** Developer override of the threat level (seconds left). */
  private forcedThreat = 0;
  private forcedThreatLeft = 0;
  /** Developer panel: pretend it is this time slot / weather / place (null fields follow the world). */
  public readonly override: { slot: TimeSlot | null; weather: string | null; place: 'cave' | 'danger' | 'attack' | null } = {
    slot: null,
    weather: null,
    place: null,
  };

  /** Builds the music graph once audio is running (after the first gesture). */
  private init(): boolean {
    if (this.ctx) return true;
    const ctx = audioEngine.context;
    const channel = audioEngine.channel('music');
    if (!ctx || !channel) return false;
    this.ctx = ctx;
    const mobile = isMobileDevice();
    this.bank = new InstrumentBank(ctx, mobile ? 22050 : 32000, mobile ? 2.5e6 : 8e6);
    // Counts queued notes and ringing tails too; a native buffer source costs next to nothing,
    // 24 keeps stealing rare with a full arrangement
    this.pool = new VoicePool(ctx, this.bank, mobile ? 24 : 40);
    const out = ctx.createGain();
    out.connect(channel);
    this.duck = ctx.createGain();
    this.stingerBus = ctx.createGain();
    this.wetSend = ctx.createGain();
    this.wetSend.gain.value = 0;
    for (const bus of [this.duck, this.stingerBus]) {
      bus.connect(out);
      bus.connect(this.wetSend);
    }
    const conv = ctx.createConvolver();
    this.wetSend.connect(conv).connect(out);
    const bank = this.bank;
    // Reverb and the danger loop's instruments in the background, so danger music starts at once
    window.setTimeout(() => {
      bank.impulse().then((ir) => {
        conv.buffer = ir;
        this.wetSend?.gain.setTargetAtTime(this.mode === 'cave' ? 0.55 : 0.25, ctx.currentTime, 0.5);
      }).catch((e) => console.warn('Music: reverb failed', e));
      const dangerPatches = new Set<string>();
      for (const s of findSongs('loop', (m) => m.includes('danger'))) for (const p of getSong(s.id)?.patches ?? []) dangerPatches.add(p);
      bank.pin(dangerPatches);
      void bank.ensure([...dangerPatches], new Set());
    }, 3000);
    this.timer = window.setInterval(() => this.tick(), 100);
    return true;
  }

  private get musicAudible(): boolean {
    return userSettings.musicOn && userSettings.music > 0.001;
  }

  /** Hands notes to the audio thread up to the lookahead horizon (runs on a timer, not the frame). */
  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const horizon = ctx.currentTime + this.lookahead;
    for (const p of [this.track, this.danger, this.motif, ...this.stingers]) p?.schedule(horizon);
    for (let i = this.stingers.length - 1; i >= 0; i--) if (this.stingers[i].done) this.stingers.splice(i, 1);
  }

  public update(_dt: number, s: MusicWorldState): void {
    if (!this.init()) return;
    const ctx = this.ctx!;
    // Real time, not game time: silences and holds still run in the editor (where the world stands
    // still); capped so a pause or a long hitch does not skip a whole silence at once
    const nowMs = performance.now();
    const dt = this.lastUpdateMs ? Math.min(0.25, (nowMs - this.lastUpdateMs) / 1000) : 0;
    this.lastUpdateMs = nowMs;
    this.clock += dt;
    if (this.forcedThreatLeft > 0) {
      this.forcedThreatLeft -= dt;
      s = { ...s, threat: Math.max(s.threat, this.forcedThreat) };
    }
    const o = this.override;
    if (o.slot || o.weather || o.place) {
      s = { ...s };
      if (o.slot) {
        s.night = o.slot === 'night' ? 1 : o.slot === 'evening' ? 0.4 : 0;
        s.timeOfDay = o.slot === 'night' ? 0 : o.slot === 'evening' ? 19 : 12;
      }
      if (o.weather) s.weather = o.weather;
      if (o.place === 'cave') s.inCave = true;
      else if (o.place) s.threat = Math.max(s.threat, o.place === 'attack' ? 2 : 1);
    }
    this.state = s;

    // Danger holds a few seconds after the threat is gone, so the loop does not flicker on and off
    if (s.threat > 0) this.dangerHold = 4;
    else this.dangerHold = Math.max(0, this.dangerHold - dt);
    const mode: Mode = this.dangerHold > 0 ? 'danger' : s.sleeping ? 'sleep' : s.inCave ? 'cave' : 'ambient';
    if (mode !== this.mode) this.switchMode(this.mode, mode);

    if (!this.musicAudible) {
      // Music switched off: stop doing any work, start fresh when it comes back
      for (const p of [this.track, this.motif]) p?.fadeOut(1);
      this.track = this.motif = null;
      this.silence = Math.max(this.silence, 5);
    } else if (this.mode === 'ambient') this.updateAmbient(dt, s);
    else if (this.mode === 'cave') this.updateCave(dt);
    else if (this.mode === 'danger') this.danger?.setLayer('attack', s.threat >= 2 ? 1 : 0, 0.4);

    // Underwater the music sinks back; a stinger briefly ducks the music under it
    const level = (s.underwater ? 0.45 : 1) * (this.clock < this.duckUntil ? 0.4 : 1);
    this.duck!.gain.setTargetAtTime(level, ctx.currentTime, 0.25);
  }

  private switchMode(from: Mode, to: Mode): void {
    this.mode = to;
    const ctx = this.ctx!;
    if (to === 'danger') {
      this.track?.fadeOut(1);
      this.motif?.fadeOut(1);
      this.track = this.motif = null;
      this.startDanger();
    } else if (from === 'danger') {
      this.danger?.fadeOut(2.5);
      this.danger = null;
      this.stinger('relief', true);
      this.silence = rand(20, 40);
    }
    if (to === 'cave') {
      this.track?.fadeOut(4);
      this.track = null;
      this.motifIn = rand(40, 90);
    } else if (from === 'cave') {
      this.motif?.fadeOut(3);
      this.motif = null;
      if (to === 'ambient') this.silence = rand(15, 30);
    }
    if (to === 'sleep') {
      this.track?.fadeOut(3);
      this.track = null;
    } else if (from === 'sleep') {
      this.stinger('morning', true);
      this.silence = rand(30, 60);
    }
    this.wetSend?.gain.setTargetAtTime(to === 'cave' ? 0.55 : 0.25, ctx.currentTime, 1);
  }

  public timeSlot(s: MusicWorldState): TimeSlot {
    if (s.night > 0.7) return 'night';
    if (s.timeOfDay >= 17 && s.timeOfDay < 23) return 'evening';
    return 'day';
  }

  private fits(mood: readonly string[], slot: TimeSlot, weather: string): boolean {
    if (!mood.includes(slot)) return false;
    return mood.includes(weather) || mood.includes('any');
  }

  private updateAmbient(dt: number, s: MusicWorldState): void {
    const slot = this.timeSlot(s);
    const tr = this.track;
    if (tr && !tr.done) {
      const fallback = WEATHER_FALLBACK[s.weather];
      if (!this.fits(tr.song.mood, slot, s.weather) && !(fallback && this.fits(tr.song.mood, slot, fallback))) {
        tr.endAtSectionBoundary(6);
        this.moodEnded = true;
      }
      tr.setLayer('night', s.night, 2);
      tr.setLayer('day', 1 - s.night, 2);
      tr.setLayer('rain', s.rain, 2);
      return;
    }
    if (tr?.done) {
      this.track = null;
      // A track that ended because the weather or time changed gives way sooner
      this.silence = this.moodEnded ? rand(10, 25) : rand(60, 240);
      this.moodEnded = false;
    }
    if (this.loading) return;
    this.silence -= dt;
    if (this.silence > 0) return;
    const song = this.pickTrack(slot, s.weather);
    if (!song) {
      // Nothing written for this time and weather yet: quiet, look again later
      this.silence = 20;
      return;
    }
    this.playTrack(song, s);
  }

  private pickTrack(slot: TimeSlot, weather: string): CompiledSong | null {
    let list = findSongs('track', (m) => this.fits(m, slot, weather));
    const fb = WEATHER_FALLBACK[weather];
    if (!list.length && fb) list = findSongs('track', (m) => this.fits(m, slot, fb));
    if (!list.length) return null;
    // Never the same track twice in a row (nor the one before, when there is a choice)
    const fresh = list.filter((s) => !this.history.includes(s.id));
    const pool = fresh.length ? fresh : list.filter((s) => s.id !== this.history[this.history.length - 1]);
    const pick = (pool.length ? pool : list)[Math.floor(Math.random() * (pool.length || list.length))];
    return getSong(pick.id);
  }

  private playTrack(song: CompiledSong, s: MusicWorldState): void {
    this.loading = true;
    const levels = { night: s.night, day: 1 - s.night, rain: s.rain };
    this.bank!.ensure(song.patches, this.inUse()).then(() => {
      this.loading = false;
      if (this.mode !== 'ambient' || this.track || !this.musicAudible) return;
      const p = new SongPlayer(this.ctx!, this.pool!, song, this.duck!, false, levels);
      p.start(this.ctx!.currentTime + 0.1, 4);
      this.track = p;
      this.history.push(song.id);
      if (this.history.length > 2) this.history.shift();
    }).catch((e) => {
      this.loading = false;
      this.silence = 30;
      console.warn('Music: could not prepare', song.id, e);
    });
  }

  private updateCave(dt: number): void {
    if (this.motif?.done) this.motif = null;
    if (this.motif || this.loading) return;
    this.motifIn -= dt;
    if (this.motifIn > 0) return;
    this.motifIn = rand(180, 360);
    const list = findSongs('motif', (m) => m.includes('cave'));
    const choice = list.filter((s) => s.id !== this.lastMotif);
    const pick = (choice.length ? choice : list)[Math.floor(Math.random() * (choice.length || list.length))];
    const song = pick && getSong(pick.id);
    if (!song) return;
    this.lastMotif = song.id;
    this.loading = true;
    this.bank!.ensure(song.patches, this.inUse()).then(() => {
      this.loading = false;
      if (this.mode !== 'cave' || !this.musicAudible) return;
      const p = new SongPlayer(this.ctx!, this.pool!, song, this.duck!, false, {});
      p.start(this.ctx!.currentTime + 0.1, 0.5);
      this.motif = p;
    }).catch(() => (this.loading = false));
  }

  private startDanger(): void {
    if (!this.musicAudible) return;
    const pick = findSongs('loop', (m) => m.includes('danger'))[0];
    const song = pick && getSong(pick.id);
    if (!song) return;
    const begin = () => {
      if (this.mode !== 'danger' || this.danger) return;
      const p = new SongPlayer(this.ctx!, this.pool!, song, this.duck!, true, { attack: (this.state?.threat ?? 0) >= 2 ? 1 : 0 });
      p.start(this.ctx!.currentTime + 0.15, 0.6);
      this.danger = p;
    };
    if (song.patches.every((p) => this.bank!.has(p))) begin();
    else void this.bank!.ensure(song.patches, this.inUse()).then(begin);
  }

  /**
   * A short tune for an achievement ('harvest', 'chest', 'build', 'relief', 'morning'). Rate
   * limited, so repeated actions do not keep ringing; skipped while danger music plays.
   */
  public stinger(event: string, force = false): void {
    if (!this.ctx || !this.musicAudible) return;
    if (!force && (this.mode === 'danger' || this.mode === 'sleep')) return;
    const now = this.clock;
    if (!force && (now - this.lastStingerAt < 3 || now < (this.stingerCooldown.get(event) ?? 0))) return;
    const list = findSongs('stinger', (m) => m.includes(event));
    if (!list.length) return;
    const song = getSong(list[Math.floor(Math.random() * list.length)].id);
    if (!song) return;
    this.lastStingerAt = now;
    this.stingerCooldown.set(event, now + 20);
    this.bank!.ensure(song.patches, this.inUse()).then(() => {
      const p = new SongPlayer(this.ctx!, this.pool!, song, this.stingerBus!, false, {});
      p.start(this.ctx!.currentTime + 0.05, 0);
      this.stingers.push(p);
      this.duckUntil = this.clock + song.duration + 0.5;
    }).catch(() => undefined);
  }

  private inUse(): Set<string> {
    const set = new Set<string>();
    for (const p of [this.track, this.danger, this.motif, ...this.stingers]) if (p && !p.done) for (const x of p.song.patches) set.add(x);
    return set;
  }

  /** Snapshot for the developer panel / console. */
  public debugInfo() {
    return {
      ready: !!this.ctx,
      oneShots: this.stingers.filter((p) => !p.done).map((p) => p.song.id),
      mode: this.mode,
      slot: this.state ? this.timeSlot(this.state) : null,
      weather: this.state?.weather ?? null,
      track: this.track ? { id: this.track.song.id, left: Math.round(this.track.remaining) } : null,
      danger: !!this.danger,
      motif: this.motif?.song.id ?? null,
      silence: Math.max(0, Math.round(this.silence)),
      voices: this.pool ? { now: this.pool.active, peak: this.pool.peak, limit: this.pool.limit, stolen: this.pool.stolen } : null,
      sampleKB: this.bank ? Math.round(this.bank.totalBytes / 1024) : 0,
      renderMs: this.bank ? Math.round(this.bank.lastRenderMs) : 0,
      renderedOn: this.bank?.renderedOn ?? '',
      songs: songIds,
    };
  }

  /** Developer: play a song now, whatever the world says (a track replaces the current one). */
  public debugPlay(id: string): void {
    const song = getSong(id);
    if (!song || !this.ctx) return;
    if (song.kind === 'track') {
      this.track?.fadeOut(1.5);
      this.track = null;
      if (this.state) this.playTrack(song, this.state);
      return;
    }
    if (song.kind === 'loop') {
      // The danger loop needs danger mode, or the director would stop it at once
      this.debugThreat(1, 12);
      return;
    }
    void this.bank!.ensure(song.patches, this.inUse()).then(() => {
      const bus = song.kind === 'stinger' ? this.stingerBus! : this.duck!;
      const p = new SongPlayer(this.ctx!, this.pool!, song, bus, false, {});
      p.start(this.ctx!.currentTime + 0.05, 0);
      this.stingers.push(p);
      if (song.kind === 'stinger') this.duckUntil = this.clock + song.duration + 0.5;
    });
  }

  /** Developer: end the silence now (the next track starts on the next frame). */
  public debugSkipSilence(): void {
    this.silence = 0;
    this.motifIn = 0;
  }

  /** Developer: fade out whatever is playing; normal silence follows. */
  public debugStop(): void {
    for (const p of [this.track, this.motif, this.danger, ...this.stingers]) p?.fadeOut(1);
    this.track = this.motif = this.danger = null;
    this.forcedThreatLeft = 0;
    this.silence = rand(60, 240);
  }

  public setVoiceLimit(n: number): void {
    if (this.pool) this.pool.limit = n;
  }

  /** Every song with what the panel shows about it. */
  public debugSongs(): { id: string; title: string; kind: string; mood: readonly string[]; seconds: number }[] {
    return songIds.map((id) => {
      const s = getSong(id);
      return { id, title: s?.title ?? id, kind: s?.kind ?? '?', mood: s?.mood ?? [], seconds: s ? s.duration : 0 };
    });
  }

  /** Developer: pretend an enemy is after the player for `seconds`. */
  public debugThreat(level: number, seconds = 15): void {
    this.forcedThreat = level;
    this.forcedThreatLeft = seconds;
  }
}

export const music: MusicDirector = ((globalThis as { __farmMusic?: MusicDirector }).__farmMusic ??= new MusicDirector());

if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { music?: MusicDirector }).music = music;
