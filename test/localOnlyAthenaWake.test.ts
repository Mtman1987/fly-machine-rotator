import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('local-only Athena wake contract', () => {
  it('requires Android on-device recognition and explicitly forbids network fallback', () => {
    const patch = read('scripts/patch-local-only-athena-wake.mjs');
    expect(patch).toContain('isOnDeviceRecognitionAvailable');
    expect(patch).toContain('createOnDeviceSpeechRecognizer');
    expect(patch).toContain('RecognizerIntent.EXTRA_PREFER_OFFLINE');
    expect(patch).toContain('on-device-wake-unavailable');
    expect(patch).toContain('Network recognition is never used for always-on wake');
    expect(patch).not.toContain('createSpeechRecognizer(this)');
    expect(patch).not.toMatch(/https?:\/\//i);
  });

  it('replaces the repeated JavaScript recognition loop with the native foreground listener', () => {
    const patch = read('scripts/patch-local-only-athena-wake.mjs');
    expect(patch).toContain('startAthenaForegroundWake');
    expect(patch).toContain('stopAthenaForegroundWake');
    expect(patch).toContain('local-wake-pending-poll');
    expect(patch).toContain('runPrivateAssistantUtterance(command, true)');
    const replacement = patch.match(/On-device Hey Athena listener active[\s\S]*?replace repeated JS speech-recognition loop/)?.[0] ?? '';
    expect(replacement).not.toContain('recognizeSpeechOnce');
  });

  it('runs local-only hardening in normal source and APK build paths', () => {
    const pkg = read('package.json');
    const workflow = read('.github/workflows/android-debug-apk.yml');
    expect(pkg).toContain('patch-local-only-athena-wake.mjs');
    expect(workflow).toContain('patch-local-only-athena-wake.mjs');
  });
});
