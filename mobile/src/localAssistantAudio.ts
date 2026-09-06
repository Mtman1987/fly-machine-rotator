import { Audio, InterruptionModeAndroid, InterruptionModeIOS, AVPlaybackStatus } from 'expo-av';

export function withoutAudio(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(withoutAudio);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^audioDataUri/.test(key) ? '[audio omitted]' : withoutAudio(item),
  ]));
}

type Callbacks = {
  apiBaseUrl: string;
  getToken: () => string;
  onStatus: (message: string) => void;
  onEnded: (requestId: string) => Promise<void>;
};

/** Phone playback only. No room, RTC connection, microphone, or platform TTS. */
export class LocalAssistantAudio {
  private music: Audio.Sound | null = null;
  private voice: Audio.Sound | null = null;
  private currentId = '';
  private generation = 0;
  private speechGeneration = 0;
  private volume = 0.85;
  private muted = false;
  private speaking = false;
  private finishSpeech: (() => void) | null = null;
  private prepareAbort: AbortController | null = null;
  private setup: Promise<void> | null = null;

  constructor(private callbacks: Callbacks) {}

  private ready() {
    if (!this.setup) this.setup = Audio.setAudioModeAsync({
      allowsRecordingIOS: false, playsInSilentModeIOS: true, staysActiveInBackground: true,
      interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      shouldDuckAndroid: true, playThroughEarpieceAndroid: false,
    }).catch(error => { this.setup = null; throw error; });
    return this.setup;
  }

  private async updateVolume() {
    await this.music?.setVolumeAsync(this.muted ? 0 : this.volume * (this.speaking ? 0.18 : 1));
  }

  async applySession(session: any) {
    const requestId = String(session?.current?.requestId || '');
    this.volume = Math.min(1, Math.max(0, Number(session?.playback?.volume ?? 85) / 100));
    this.muted = session?.playback?.muted === true;
    if (requestId && requestId === this.currentId && this.music) {
      await this.updateVolume();
      if (session.playback?.status === 'playing') await this.music.playAsync();
      else await this.music.pauseAsync();
      return;
    }
    const generation = ++this.generation;
    this.prepareAbort?.abort();
    const abort = new AbortController();
    this.prepareAbort = abort;
    const old = this.music;
    this.music = null;
    this.currentId = requestId;
    if (old) { old.setOnPlaybackStatusUpdate(null); await old.unloadAsync(); }
    if (!requestId) { this.callbacks.onStatus('Music stopped.'); return; }
    const item = session.current.item;
    const videoId = item?.metadata?.videoId || String(item?.id || '').replace(/^youtube-/, '');
    const offlineId = item?.metadata?.provider === 'offline' ? String(item.id || '').replace(/^offline-/, '') : '';
    const offline = /^[A-Za-z0-9_-]{1,1024}$/.test(offlineId);
    if (!offline && !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('This music source does not offer mobile playback yet.');
    const uri = `${this.callbacks.apiBaseUrl}/private-assistant/media/` + (offline ? `offline/${offlineId}` : `youtube/${videoId}/index.m3u8`);
    const headers = { Authorization: `Bearer ${this.callbacks.getToken()}` };
    this.callbacks.onStatus(`Preparing ${item.title || 'your song'}…`);
    try {
      await this.ready();
      // Do not hand ExoPlayer the source's 202 JSON while HLS is preparing.
      const deadline = Date.now() + 180_000;
      for (; !offline;) {
        const response = await fetch(uri, { headers, signal: abort.signal });
        const body = await response.text();
        if (generation !== this.generation) return;
        if (response.ok && response.status !== 202 && body.trimStart().startsWith('#EXTM3U')) break;
        if (![202, 429, 502, 503, 504].includes(response.status) || Date.now() > deadline) {
          throw new Error(response.status === 401 ? 'Sign in to restore music playback.' : `Music source could not start (${response.status}). Please try the song again.`);
        }
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); reject(new Error('Playback cancelled')); };
          const timer = setTimeout(() => { abort.signal.removeEventListener('abort', cancel); resolve(); }, 3000);
          abort.signal.addEventListener('abort', cancel, { once: true });
        });
      }
      const sound = new Audio.Sound();
      let ended = false;
      let announced = false;
      sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
        if (generation !== this.generation) return;
        if (!status.isLoaded) {
          if (status.error) this.callbacks.onStatus(`Music playback failed: ${status.error}`);
          return;
        }
        if (status.isPlaying && !announced) {
          announced = true;
          this.callbacks.onStatus(`Playing ${item.title || 'your song'}`);
        }
        if (status.didJustFinish && !ended) {
          ended = true;
          void this.callbacks.onEnded(requestId).catch(error => this.callbacks.onStatus(`Next song could not start: ${String(error.message || error)}`));
        }
      });
      await sound.loadAsync({ uri, headers, ...(offline ? {} : { overrideFileExtensionAndroid: 'm3u8' }) }, {
        shouldPlay: false, volume: this.muted ? 0 : this.volume * (this.speaking ? 0.18 : 1),
        positionMillis: Math.max(0, Number(session.playback?.position || 0) * 1000),
      });
      if (generation !== this.generation) { await sound.unloadAsync(); return; }
      this.music = sound;
      await this.updateVolume();
      if (session.playback?.status === 'playing') await sound.playAsync();
    } catch (error) {
      if (generation !== this.generation || abort.signal.aborted) return;
      this.currentId = '';
      throw error;
    }
  }

  async stopSpeech() {
    ++this.speechGeneration;
    this.finishSpeech?.();
    this.finishSpeech = null;
    const voice = this.voice;
    this.voice = null;
    if (voice) { voice.setOnPlaybackStatusUpdate(null); await voice.unloadAsync().catch(() => {}); }
    this.speaking = false;
    await this.updateVolume();
  }

  async speak(uris: string[]) {
    await this.stopSpeech();
    const generation = this.speechGeneration;
    await this.ready();
    this.speaking = true;
    await this.updateVolume();
    try {
      for (const uri of uris) {
        if (generation !== this.speechGeneration) return;
        if (typeof uri !== 'string' || !/^data:audio\//.test(uri)) throw new Error('Voice service returned invalid audio');
        const sound = new Audio.Sound();
        this.voice = sound;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => finish(new Error('Voice playback timed out')), 180_000);
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            this.finishSpeech = null;
            error ? reject(error) : resolve();
          };
          this.finishSpeech = () => finish();
          sound.setOnPlaybackStatusUpdate(status => {
            if (!status.isLoaded && status.error) finish(new Error(status.error));
            else if (status.isLoaded && status.didJustFinish) finish();
          });
          void sound.loadAsync({ uri }, { shouldPlay: false }).then(async () => {
            if (generation === this.speechGeneration) await sound.playAsync();
            else finish();
          }).catch(error => finish(error));
        });
        sound.setOnPlaybackStatusUpdate(null);
        await sound.unloadAsync().catch(() => {});
        if (this.voice === sound) this.voice = null;
      }
    } finally {
      if (generation === this.speechGeneration) {
        await this.stopSpeech();
      }
    }
  }

  async dispose() {
    ++this.generation;
    this.prepareAbort?.abort();
    await this.stopSpeech();
    const sound = this.music;
    this.music = null;
    this.currentId = '';
    if (sound) { sound.setOnPlaybackStatusUpdate(null); await sound.unloadAsync().catch(() => {}); }
  }
}
