import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('glasses Athena control surface build wiring', () => {
  it('adds an SPMT-authorized private-room Coder endpoint with confirmation-gated publishing', () => {
    const patch = read('scripts/patch-athena-room-coder-control.mjs');
    expect(patch).toContain('/api/athena/control');
    expect(patch).toContain('requireSpmtAdmin');
    expect(patch).toContain("action === 'create'");
    expect(patch).toContain("action === 'artifact'");
    expect(patch).toContain("action === 'publish'");
    expect(patch).toContain('input.confirmed !== true');
    expect(patch).toContain('This will not merge or deploy it');
  });

  it('builds a native microphone foreground service and returns wake commands to MountainView', () => {
    const patch = read('scripts/patch-native-athena-foreground-wake.mjs');
    expect(patch).toContain('MountainViewAthenaWakeService');
    expect(patch).toContain('FOREGROUND_SERVICE_MICROPHONE');
    expect(patch).toContain('SpeechRecognizer');
    expect(patch).toContain('startAthenaForegroundWake');
    expect(patch).toContain('consumePendingWakeCommand');
    expect(patch).toContain('foreground-wake-command');
    expect(patch).toContain('runPrivateAssistantUtterance(command, true)');
  });

  it('runs both patches in normal server and APK build paths', () => {
    const pkg = read('package.json');
    const workflow = read('.github/workflows/android-debug-apk.yml');
    for (const name of ['patch-athena-room-coder-control.mjs', 'patch-native-athena-foreground-wake.mjs']) {
      expect(pkg).toContain(name);
      expect(workflow).toContain(name);
    }
  });
});
