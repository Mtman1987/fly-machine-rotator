import { readFile, writeFile } from 'node:fs/promises';

async function patch(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) {
    console.log(`local-only Athena wake already patched: ${path}`);
    return;
  }
  await writeFile(path, after, 'utf8');
  console.log(`patched local-only Athena wake: ${path}`);
}

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`local-only Athena wake marker missing: ${label}`);
  return source.replace(pattern, replacement);
}

await patch('mobile/plugins/withMetaWearablesAndroid.js', (source) => {
  if (!source.includes('MountainViewAthenaWakeService')) {
    throw new Error('native Athena foreground wake patch must run before local-only hardening');
  }

  source = source.replace(
    '      .setContentText("Listening for Hey Athena from your glasses")',
    '      .setContentText("Listening locally for Hey Athena")',
  );

  if (!source.includes('createOnDeviceSpeechRecognizer(this)')) {
    source = replaceRequired(
      source,
      /    if \(!SpeechRecognizer\.isRecognitionAvailable\(this\)\) \{\n      startListeningSoon\(5000\)\n      return\n    \}\n    if \(recognizer == null\) \{\n      recognizer = SpeechRecognizer\.createSpeechRecognizer\(this\)\n      recognizer\?\.setRecognitionListener\(this\)\n    \}/,
      `    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
      getSharedPreferences(PREFS, MODE_PRIVATE).edit()
        .putString(PREF_WAKE_STATE, "on-device-unavailable")
        .apply()
      stopSelf()
      return
    }
    if (recognizer == null) {
      recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this)
      recognizer?.setRecognitionListener(this)
    }`,
      'on-device recognizer creation',
    );
  }

  if (!source.includes('RecognizerIntent.EXTRA_PREFER_OFFLINE')) {
    source = replaceRequired(
      source,
      /      putExtra\(RecognizerIntent\.EXTRA_CALLING_PACKAGE, packageName\)\n/,
      `      putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
`,
      'offline recognizer preference',
    );
  }

  if (!source.includes('const val PREF_WAKE_STATE')) {
    source = replaceRequired(
      source,
      /    const val PENDING_AT = "pending_at"\n/,
      `    const val PENDING_AT = "pending_at"
    const val PREF_WAKE_STATE = "wake_state"
`,
      'wake state preference',
    );
  }

  if (!source.includes('on-device-wake-unavailable')) {
    source = replaceRequired(
      source,
      /  fun startAthenaForegroundWake\(promise: Promise\) \{\n    try \{\n      if \(reactContext\.checkSelfPermission\(Manifest\.permission\.RECORD_AUDIO\) != PackageManager\.PERMISSION_GRANTED\) \{\n        promise\.reject\("VOICE_PERMISSION_REQUIRED", "Grant microphone permission before enabling Athena foreground wake\."\)\n        return\n      \}\n/,
      `  fun startAthenaForegroundWake(promise: Promise) {
    try {
      if (reactContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        promise.reject("VOICE_PERMISSION_REQUIRED", "Grant microphone permission before enabling Athena foreground wake.")
        return
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !SpeechRecognizer.isOnDeviceRecognitionAvailable(reactContext)) {
        val unavailable = WritableNativeMap()
        unavailable.putBoolean("androidNativeBridge", true)
        unavailable.putBoolean("localOnly", true)
        unavailable.putString("state", "on-device-wake-unavailable")
        unavailable.putString("note", "Install an offline Android speech model or use the manual Talk control. Network recognition is never used for always-on wake.")
        promise.resolve(unavailable)
        return
      }
`,
      'native start availability gate',
    );
    source = source.replace(
      '      result.putString("state", "foreground-wake-started")\n      result.putString("note", "Native foreground service is listening for Athena/Annie wake phrases.")',
      '      result.putString("state", "foreground-wake-started")\n      result.putBoolean("localOnly", true)\n      result.putString("note", "Native on-device foreground service is listening locally for Hey Athena.")',
    );
  }

  return source;
});

await patch('mobile/App.tsx', (source) => {
  if (!source.includes('async function startWakeListener()')) throw new Error('mobile wake controls are missing');

  if (!source.includes('On-device Hey Athena listener active.')) {
    source = replaceRequired(
      source,
      /  async function startWakeListener\(\) \{[\s\S]*?\n  function stopWakeListener\(\) \{[\s\S]*?\n  \}\n/,
      `  async function startWakeListener() {
    if (wakeListenerActiveRef.current) return;
    try {
      const result = await metaWearables.startAthenaForegroundWake();
      const state = String(result.state ?? "");
      if (state === "on-device-wake-unavailable") {
        wakeListenerActiveRef.current = false;
        setWakeListenerActive(false);
        setIsListening(false);
        const note = String(result.note ?? "On-device speech recognition is unavailable. Use the manual Talk control.");
        setStatusMessage(note);
        setLog(note);
        appendActivityLog("voice", "Local Hey Athena wake", "unavailable", result);
        return;
      }
      wakeListenerActiveRef.current = true;
      setWakeListenerActive(true);
      setIsListening(false);
      setStatusMessage("On-device Hey Athena listener active.");
      setLog("Hey Athena is being detected locally on this device. Ordinary speech is not sent to cloud STT for wake detection.");
      appendActivityLog("voice", "Local Hey Athena wake", "listening", result);
    } catch (error) {
      wakeListenerActiveRef.current = false;
      setWakeListenerActive(false);
      setIsListening(false);
      reportSoftError("Local Hey Athena wake", error);
    }
  }

  async function stopWakeListener() {
    wakeListenerActiveRef.current = false;
    setWakeListenerActive(false);
    setIsListening(false);
    await metaWearables.stopAthenaForegroundWake().catch((error) => reportSoftError("Stop local Hey Athena wake", error));
    setStatusMessage("Hey Athena listener stopped.");
  }
`,
      'replace repeated JS speech-recognition loop',
    );
  }

  // The native foreground service may wake an already-running Activity. Polling
  // its private SharedPreferences bridge is entirely local and guarantees the
  // captured command is consumed whether the app was launched or already open.
  if (!source.includes('local-wake-pending-poll')) {
    const marker = '  useEffect(() => {\n    tokenRef.current = token;';
    const insert = `  useEffect(() => {
    let cancelled = false;
    let busy = false;
    const consume = async () => {
      if (cancelled || busy) return;
      busy = true;
      try {
        const wake = await metaWearables.consumePendingWakeCommand();
        const command = String(wake.command ?? wake.transcript ?? "").trim();
        if (!cancelled && command) {
          appendActivityLog("voice", "Local Hey Athena wake", "captured", wake);
          setVoicePrompt(command);
          await trackMobileEvent("local-wake-pending-poll", wake, "captured");
          await runPrivateAssistantUtterance(command, true);
        }
      } catch (error) {
        if (!cancelled) reportSoftError("Local Hey Athena wake", error);
      } finally {
        busy = false;
      }
    };
    const interval = setInterval(() => void consume(), 750);
    return () => { cancelled = true; clearInterval(interval); };
  }, [token]);

${marker}`;
    if (!source.includes(marker)) throw new Error('mobile token effect marker missing');
    source = source.replace(marker, insert);
  }

  return source;
});
