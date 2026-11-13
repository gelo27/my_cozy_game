import { audioEngine } from '../AudioEngine';
import { isMobileDevice } from '../../world/WorldSettings';
import { userSettings } from '../../config/userSettings';
import { InstrumentBank } from './InstrumentBank';
import { LOOKAHEAD_DESKTOP, LOOKAHEAD_MOBILE, SongPlayer, VoicePool } from './MusicEngine';
import { findSongs, getSong, songIds } from './library';
import type { CompiledSong } from './SongFormat';
import type { SpaceName } from './synth';

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

/** Seconds danger music outlasts the threat, and the attack layer the last strike. */
const DANGER_HOLD = 7;
const ATTACK_HOLD = 3;

/**
 * Decides what music plays, in priority order: the danger music while an enemy is after the player,
 * then a track for the place: underground the cave tracks, outside one for the time of day and
 * weather, with long silences between tracks.
 *
 * Danger music is layered (vertical layering, as in most action scores): a hit and a low drone with a
 * heartbeat the moment the player is spotted, the chase layer (string ostinato, toms, pulse, horns)
 * swelling in, and the attack layer (big drums, snare, brass stabs, high strings) while the enemy
 * strikes. Layers have hold times, so they never flicker; losing the enemy strips the layers back to
 * the drone before the music fades.
 *
 * A track is never cut mid-phrase when the weather turns: it finishes its section and fades.
 */
class MusicDirector {
  private ctx: AudioContext | null = null;
  private bank: InstrumentBank | null = null;
  private pool: VoicePool | null = null;
  /** All music (sinks back underwater). */
  private duck: GainNode | null = null;
  private wetSend: GainNode | null = null;
  private conv: ConvolverNode | null = null;
  /** Rendered reverb impulses (each is ~0.3-1 MB at the context rate, so only a couple are kept). */
  private readonly irs = new Map<SpaceName, AudioBuffer>();
  private space: SpaceName | null = null;
  private wantSpace: { space: SpaceName; wet: number } = { space: 'hall', wet: 0.25 };
  private timer = 0;
  private lookahead = isMobileDevice() ? LOOKAHEAD_MOBILE : LOOKAHEAD_DESKTOP;

  private mode: Mode = 'ambient';
  private track: SongPlayer | null = null;
  private danger: SongPlayer | null = null;
  private loading = false;
  /** Bumped by every track request: a slower earlier request that finishes loading later is dropped. */
  private trackReq = 0;
  /** The track was started from the developer panel: it plays to its end whatever the weather. */
  private forcedTrack = false;
  /** Seconds of silence left before the next track (game time, frozen while paused). */
  private silence = rand(8, 20);
  private moodEnded = false;
  private dangerHold = 0;
  private dangerLoading = false;
  /** Seconds the attack layer stays up after the last strike. */
  private attackHold = 0;
  private layerChase = 0;
  private layerAttack = 0;
  private readonly history: string[] = [];
  private clock = 0;
  private lastUpdateMs = 0;
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
    this.wetSend = ctx.createGain();
    this.wetSend.gain.value = 0;
    this.duck.connect(out);
    this.duck.connect(this.wetSend);
    const conv = ctx.createConvolver();
    this.conv = conv;
    this.wetSend.connect(conv).connect(out);
    const bank = this.bank;
    // Reverb and the danger loop's instruments in the background, so danger music starts at once
    window.setTimeout(() => {
      this.applySpace();
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
    for (const p of [this.track, this.danger]) p?.schedule(horizon);
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

    // Danger holds a while after the threat is gone (the enemy lost sight for a moment, or it was
    // only a glimpse): the chase layers fall away first, then the drone fades
    if (s.threat > 0) this.dangerHold = DANGER_HOLD;
    else this.dangerHold = Math.max(0, this.dangerHold - dt);
    const mode: Mode = this.dangerHold > 0 ? 'danger' : s.sleeping ? 'sleep' : s.inCave ? 'cave' : 'ambient';
    if (mode !== this.mode) this.switchMode(this.mode, mode);

    if (!this.musicAudible) {
      // Music switched off: stop doing any work, start fresh when it comes back
      this.track?.fadeOut(1);
      this.danger?.fadeOut(1);
      this.track = this.danger = null;
      this.silence = Math.max(this.silence, 5);
    } else if (this.mode === 'ambient' || this.mode === 'cave') this.updateAmbient(dt, s);
    else if (this.mode === 'danger') this.updateDanger(dt, s);
    // Asleep there is no music at all

    // Underwater the music sinks back
    this.duck!.gain.setTargetAtTime(s.underwater ? 0.45 : 1, ctx.currentTime, 0.25);
  }

  private switchMode(from: Mode, to: Mode): void {
    this.mode = to;
    if (to === 'danger') {
      this.track?.fadeOut(1);
      this.track = null;
      this.startDanger();
    } else if (from === 'danger') {
      this.danger?.fadeOut(3);
      this.danger = null;
      this.silence = rand(20, 40);
    }
    // Into a cave and out of it: the outside track (or the cave one) fades, the other kind follows soon
    if (to === 'cave' || (from === 'cave' && to === 'ambient')) {
      this.track?.fadeOut(4);
      this.track = null;
      this.forcedTrack = false;
      this.silence = rand(10, 25);
    }
    if (to === 'sleep') {
      this.track?.fadeOut(3);
      this.track = null;
    } else if (from === 'sleep') this.silence = rand(30, 60);
    // Danger brings its own room (the cave's stone when it is underground); the cave its echo
    if (to === 'cave') this.setSpace('cave', 0.5);
    else if (to !== 'danger' && (from === 'cave' || from === 'danger')) this.setSpace('hall', 0.25);
  }

  /**
   * Danger intensity, from the threat: 1 an enemy is after the player, 2 it is striking. The chase
   * layer swells in over a couple of seconds after the hit; the attack layer slams in at once and
   * holds a few seconds after the last strike, so a biting spider does not make the drums stutter.
   * Once the threat is gone only the drone and heartbeat remain until the music fades.
   */
  private updateDanger(dt: number, s: MusicWorldState): void {
    if (!this.danger) {
      this.startDanger();
      return;
    }
    if (s.threat >= 2) this.attackHold = ATTACK_HOLD;
    else this.attackHold = Math.max(0, this.attackHold - dt);
    const attack = this.attackHold > 0 ? 1 : 0;
    const chase = s.threat > 0 || attack ? 1 : 0;
    if (attack !== this.layerAttack) this.danger.setLayer('attack', attack, attack ? 0.08 : 1.2);
    if (chase !== this.layerChase) this.danger.setLayer('chase', chase, chase ? 0.7 : 1.5);
    this.layerAttack = attack;
    this.layerChase = chase;
  }

  /**
   * Reverb for what plays now: a track brings its own room (a porch, a field, a hall), the cave its
   * stone. The impulse is swapped only behind a quick dip of the reverb send, never mid-tail.
   */
  private setSpace(space: SpaceName, wet: number): void {
    this.wantSpace = { space, wet };
    if (this.conv?.buffer || this.space === null) this.applySpace();
  }

  private applySpace(): void {
    const ctx = this.ctx, conv = this.conv, send = this.wetSend, bank = this.bank;
    if (!ctx || !conv || !send || !bank) return;
    const { space, wet } = this.wantSpace;
    if (space === this.space) {
      send.gain.setTargetAtTime(wet, ctx.currentTime, 0.8);
      return;
    }
    const swap = (ir: AudioBuffer) => {
      if (this.wantSpace.space !== space) return;
      const had = !!conv.buffer;
      send.gain.cancelScheduledValues(ctx.currentTime);
      send.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      window.setTimeout(() => {
        if (this.wantSpace.space !== space) return;
        conv.buffer = ir;
        this.space = space;
        send.gain.setTargetAtTime(this.wantSpace.wet, ctx.currentTime, had ? 0.6 : 0.3);
        // Keep the cave's and one more; on a phone only the one in use
        const keep = isMobileDevice() ? 1 : 2;
        for (const k of [...this.irs.keys()]) if (this.irs.size > keep && k !== space) this.irs.delete(k);
      }, had ? 300 : 0);
    };
    const cached = this.irs.get(space);
    if (cached) swap(cached);
    else
      bank.impulse(space).then((ir) => {
        this.irs.set(space, ir);
        swap(ir);
      }).catch((e) => console.warn('Music: reverb failed', e));
  }

  public timeSlot(s: MusicWorldState): TimeSlot {
    if (s.night > 0.7) return 'night';
    if (s.timeOfDay >= 17 && s.timeOfDay < 23) return 'evening';
    return 'day';
  }

  /** Whether a track belongs here: underground only the cave tracks, outside the time and weather ones. */
  private fitsNow(mood: readonly string[], slot: TimeSlot, weather: string): boolean {
    if (this.mode === 'cave') return mood.includes('cave');
    const fb = WEATHER_FALLBACK[weather];
    return this.fits(mood, slot, weather) || (!!fb && this.fits(mood, slot, fb));
  }

  private fits(mood: readonly string[], slot: TimeSlot, weather: string): boolean {
    if (!mood.includes(slot)) return false;
    return mood.includes(weather) || mood.includes('any');
  }

  private updateAmbient(dt: number, s: MusicWorldState): void {
    const slot = this.timeSlot(s);
    const tr = this.track;
    if (tr && !tr.done) {
      if (!this.forcedTrack && !this.fitsNow(tr.song.mood, slot, s.weather)) {
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
      this.forcedTrack = false;
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
    let list = findSongs('track', (m) => (this.mode === 'cave' ? m.includes('cave') : this.fits(m, slot, weather)));
    const fb = WEATHER_FALLBACK[weather];
    if (!list.length && fb && this.mode !== 'cave') list = findSongs('track', (m) => this.fits(m, slot, fb));
    if (!list.length) return null;
    // Never the same track twice in a row (nor the one before, when there is a choice)
    const fresh = list.filter((s) => !this.history.includes(s.id));
    const pool = fresh.length ? fresh : list.filter((s) => s.id !== this.history[this.history.length - 1]);
    const pick = (pool.length ? pool : list)[Math.floor(Math.random() * (pool.length || list.length))];
    return getSong(pick.id);
  }

  /** Starts a track once its instruments are ready. A forced one (developer panel) replaces whatever plays. */
  private playTrack(song: CompiledSong, s: MusicWorldState, forced = false): void {
    const req = ++this.trackReq;
    const mode = this.mode;
    this.loading = true;
    const levels = { night: s.night, day: 1 - s.night, rain: s.rain };
    this.bank!.ensure(song.patches, this.inUse()).then(() => {
      // A newer request (another click in the panel, a stop) took over while this one loaded
      if (req !== this.trackReq) return;
      this.loading = false;
      if (forced) {
        if (this.mode === 'danger' || this.mode === 'sleep' || !this.musicAudible) return;
        this.track?.fadeOut(1.5);
        this.track = null;
        this.moodEnded = false;
      } else if (this.mode !== mode || this.track || !this.musicAudible) return;
      this.forcedTrack = forced;
      this.setSpace(song.space, song.wet);
      const p = new SongPlayer(this.ctx!, this.pool!, song, this.duck!, false, levels);
      p.start(this.ctx!.currentTime + 0.1, 4);
      this.track = p;
      this.history.push(song.id);
      if (this.history.length > 2) this.history.shift();
    }).catch((e) => {
      if (req !== this.trackReq) return;
      this.loading = false;
      this.silence = 30;
      console.warn('Music: could not prepare', song.id, e);
    });
  }

  /** Plays the danger music now: the hit lands the moment the player is spotted. */
  private startDanger(): void {
    if (!this.musicAudible || this.dangerLoading) return;
    const pick = findSongs('loop', (m) => m.includes('danger'))[0];
    const song = pick && getSong(pick.id);
    if (!song) return;
    if (this.state?.inCave) this.setSpace('cave', 0.3);
    else this.setSpace(song.space, song.wet);
    const begin = () => {
      this.dangerLoading = false;
      if (this.mode !== 'danger' || this.danger || !this.musicAudible) return;
      const attack = (this.state?.threat ?? 0) >= 2;
      this.attackHold = attack ? ATTACK_HOLD : 0;
      this.layerAttack = attack ? 1 : 0;
      this.layerChase = 0;
      // The chase layer starts silent and swells in on the first update
      const p = new SongPlayer(this.ctx!, this.pool!, song, this.duck!, true, { attack: this.layerAttack, chase: 0 });
      p.start(this.ctx!.currentTime + 0.03, 0);
      this.danger = p;
    };
    if (song.patches.every((p) => this.bank!.has(p))) begin();
    else {
      this.dangerLoading = true;
      this.bank!.ensure(song.patches, this.inUse()).then(begin).catch((e) => {
        this.dangerLoading = false;
        console.warn('Music: danger music failed', e);
      });
    }
  }

  private inUse(): Set<string> {
    const set = new Set<string>();
    for (const p of [this.track, this.danger]) if (p && !p.done) for (const x of p.song.patches) set.add(x);
    return set;
  }

  /** Snapshot for the developer panel / console. */
  public debugInfo() {
    return {
      ready: !!this.ctx,
      mode: this.mode,
      space: this.space,
      slot: this.state ? this.timeSlot(this.state) : null,
      weather: this.state?.weather ?? null,
      track: this.track ? { id: this.track.song.id, left: Math.round(this.track.remaining) } : null,
      danger: this.danger ? { chase: this.layerChase, attack: this.layerAttack, hold: Math.ceil(this.dangerHold) } : null,
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
      // The current track keeps playing until the new one is ready, then crossfades into it
      if (this.state) this.playTrack(song, this.state, true);
      return;
    }
    // The danger music needs danger mode, or the director would stop it at once
    if (song.kind === 'loop') this.debugThreat(1, 12);
  }

  /** Developer: end the silence now (the next track starts on the next frame). */
  public debugSkipSilence(): void {
    this.silence = 0;
  }

  /** Developer: fade out whatever is playing; normal silence follows. */
  public debugStop(): void {
    this.track?.fadeOut(1);
    this.danger?.fadeOut(1);
    this.track = this.danger = null;
    this.forcedThreatLeft = 0;
    this.forcedTrack = false;
    this.loading = false;
    // Drops a track still loading, so it does not start after the stop
    this.trackReq++;
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

// The director lives on globalThis so a hot update cannot start a second one, but then a hot
// update would leave the old one running old code against new instruments and songs (notes
// scheduled, nothing rendered: silence). Any change under audio/music reloads the page instead.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
