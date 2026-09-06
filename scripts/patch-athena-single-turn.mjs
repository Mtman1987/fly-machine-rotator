import { readFile, writeFile } from 'node:fs/promises';

function required(source, from, to) {
  if (!source.includes(from)) throw new Error(`single-turn patch marker missing: ${from.slice(0, 90)}`);
  return source.replace(from, to);
}

let app = await readFile('mobile/App.tsx', 'utf8');
if (!app.includes('assistantTurnControl')) {
  app = 'import { AssistantTurnControl, WakeSuppression } from "./src/assistantTurnControl";\n' + app;
  // Polling handles startup and foreground delivery; a second consumer races it.
  const start = app.indexOf('  useEffect(() => {\n    let cancelled = false;\n    const consume = async () => {');
  const end = app.indexOf('  }, [token]);', start);
  if (start < 0 || !app.slice(start, end).includes('foreground-wake-command')) throw new Error('startup wake effect missing');
  app = app.slice(0, start) + '  // foreground-wake-command is consumed by the single polling handler below.\n' + app.slice(end + '  }, [token]);'.length);
  app = required(app, '      if (cancelled || busy) return;', '      if (cancelled || busy || !tokenRef.current) return;');
  app = required(app, '          await runPrivateAssistantUtterance(command, true);', '          await runPrivateAssistantUtterance(command, true, `wake-${wake.capturedAt}`);');
  app = required(app, '  async function runPrivateAssistantUtterance(message: string, speakReply = true) {', `  const turnControlRef = useRef(new AssistantTurnControl());
  const manualListenBusyRef = useRef(false);
  const wakeSuppressionRef = useRef(new WakeSuppression((value) => metaWearables.setAthenaWakeSuppressed(value)));

  async function runPrivateAssistantUtterance(message: string, speakReply = true, eventId?: string) {
    return turnControlRef.current.run(eventId, () => executePrivateAssistantUtterance(message, speakReply, eventId));
  }

  async function executePrivateAssistantUtterance(message: string, speakReply: boolean, eventId?: string) {`);
  app = required(app, 'requestId: `companion-${Date.now()}-${Math.random().toString(36).slice(2)}`', 'requestId: eventId || `companion-${Date.now()}-${Math.random().toString(36).slice(2)}`');
  app = required(app, 'await localAudio().speak(tts.audioDataUris || [tts.audioDataUri]);', 'await wakeSuppressionRef.current.run(() => localAudio().speak(tts.audioDataUris || [tts.audioDataUri]));');
  app = app.replaceAll('await metaWearables.recognizeSpeechOnce()', 'await wakeSuppressionRef.current.run(() => metaWearables.recognizeSpeechOnce())');
  app = required(app, '  async function listenAndRunVoiceCommander(fallbackPrompt = voicePrompt, visualContextOverride?: string, commandMode = false) {\n    try {', '  async function listenAndRunVoiceCommander(fallbackPrompt = voicePrompt, visualContextOverride?: string, commandMode = false) {\n    if (manualListenBusyRef.current) return;\n    manualListenBusyRef.current = true;\n    try {');
  app = required(app, 'reportError("Listen and ask Athena", error);\n    } finally {\n      setIsListening(false);', 'reportError("Listen and ask Athena", error);\n    } finally {\n      manualListenBusyRef.current = false;\n      setIsListening(false);');
  await writeFile('mobile/App.tsx', app);
}

let bridge = await readFile('mobile/src/metaWearables.ts', 'utf8');
if (!bridge.includes('setAthenaWakeSuppressed')) {
  bridge = required(bridge, '  consumePendingWakeCommand(): Promise<Record<string, unknown>>;', '  consumePendingWakeCommand(): Promise<Record<string, unknown>>;\n  setAthenaWakeSuppressed(suppressed: boolean): Promise<Record<string, unknown>>;');
  bridge = required(bridge, '  consumePendingWakeCommand: () =>', '  setAthenaWakeSuppressed: (suppressed: boolean) => nativeModule?.setAthenaWakeSuppressed?.(suppressed) ?? unavailable("setAthenaWakeSuppressed"),\n  consumePendingWakeCommand: () =>');
  await writeFile('mobile/src/metaWearables.ts', bridge);
}

let native = await readFile('mobile/plugins/withMetaWearablesAndroid.js', 'utf8');
if (!native.includes('fun setAthenaWakeSuppressed')) {
  native = required(native, '  private var running = true', '  private var running = true\n  private var resultHandled = false');
  native = required(native, '    createChannel()\n', '    activeService = this\n    createChannel()\n');
  native = required(native, '    running = false\n', '    running = false\n    activeService = null\n');
  native = required(native, '  private fun startListening() {\n    if (!running) return', `  fun onSuppressionChanged(value: Boolean) {
    handler.removeCallbacksAndMessages(null)
    if (value) {
      resultHandled = true
      recognizer?.cancel()
    } else {
      // Let the speaker and Bluetooth output finish draining before wake resumes.
      startListeningSoon(700)
    }
  }

  private fun startListening() {
    if (!running || suppressed) return
    resultHandled = false`);
  native = required(native, 'putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)', 'putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)');
  native = required(native, 'putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)', 'putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)');
  native = required(native, `    results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.forEach { inspect(it) }
    startListeningSoon(300)`, `    if (!running || suppressed || resultHandled) return
    resultHandled = true
    // Recognition alternatives describe one utterance; only accept the best final one.
    results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { inspect(it) }
    startListeningSoon(300)`);
  native = required(native, `    partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.forEach { inspect(it) }`, '    // Partial words are previews, never separate assistant commands.');
  native = required(native, '    const val CHANNEL_ID = "mountainview-athena-wake"', '    @Volatile var suppressed = false\n    var activeService: MountainViewAthenaWakeService? = null\n    const val CHANNEL_ID = "mountainview-athena-wake"');
  native = required(native, '  @ReactMethod\n  fun consumePendingWakeCommand(promise: Promise) {', `  @ReactMethod
  fun setAthenaWakeSuppressed(value: Boolean, promise: Promise) {
    reactContext.runOnUiQueueThread {
      try {
        MountainViewAthenaWakeService.suppressed = value
        if (value) {
          // Discard a wake captured during the transition to manual capture/output.
          reactContext.getSharedPreferences(MountainViewAthenaWakeService.PREFS, Context.MODE_PRIVATE).edit()
            .remove(MountainViewAthenaWakeService.PENDING_COMMAND)
            .remove(MountainViewAthenaWakeService.PENDING_TRANSCRIPT)
            .remove(MountainViewAthenaWakeService.PENDING_AT).apply()
        }
        MountainViewAthenaWakeService.activeService?.onSuppressionChanged(value)
        val result = WritableNativeMap()
        result.putBoolean("suppressed", value)
        promise.resolve(result)
      } catch (error: Exception) {
        promise.reject("ATHENA_WAKE_SUPPRESSION_FAILED", error.message, error)
      }
    }
  }

  @ReactMethod
  fun consumePendingWakeCommand(promise: Promise) {`);
  await writeFile('mobile/plugins/withMetaWearablesAndroid.js', native);
}
console.log('Athena single-turn and speech echo protection applied');
