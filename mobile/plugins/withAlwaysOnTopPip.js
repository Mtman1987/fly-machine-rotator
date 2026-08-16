const { createRunOncePlugin, withAndroidManifest, withMainActivity } = require('@expo/config-plugins');

function withAlwaysOnTopPip(config) {
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android application manifest entry missing');
    const activities = application.activity || [];
    const main = activities.find((activity) => String(activity?.$?.['android:name'] || '').endsWith('.MainActivity'))
      || activities.find((activity) => String(activity?.$?.['android:name'] || '') === '.MainActivity');
    if (!main) throw new Error('Android MainActivity manifest entry missing');
    main.$['android:supportsPictureInPicture'] = 'true';
    main.$['android:resizeableActivity'] = 'true';
    return mod;
  });

  config = withMainActivity(config, (mod) => {
    let source = mod.modResults.contents;
    if (source.includes('mountainViewAlwaysOnTopPip')) return mod;

    const packageLine = source.match(/^package\s+[^\n]+/m)?.[0];
    if (!packageLine) throw new Error('MainActivity package marker missing');
    const imports = [
      'import android.app.PictureInPictureParams',
      'import android.os.Build',
      'import android.util.Rational',
    ].filter((line) => !source.includes(line));
    if (imports.length) source = source.replace(packageLine, `${packageLine}\n\n${imports.join('\n')}`);

    const classMarker = /class\s+MainActivity\s*:\s*ReactActivity\(\)\s*\{/;
    if (!classMarker.test(source)) throw new Error('MainActivity class marker missing');

    const block = `class MainActivity : ReactActivity() {\n  private val mountainViewAlwaysOnTopPip = true\n\n  private fun mountainViewPipParams(autoEnter: Boolean): PictureInPictureParams {\n    val builder = PictureInPictureParams.Builder()\n      .setAspectRatio(Rational(9, 16))\n    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {\n      builder.setAutoEnterEnabled(autoEnter)\n      builder.setSeamlessResizeEnabled(true)\n    }\n    return builder.build()\n  }\n\n  private fun enforceMountainViewAlwaysOnTop() {\n    if (!mountainViewAlwaysOnTopPip || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return\n    try {\n      setPictureInPictureParams(mountainViewPipParams(true))\n    } catch (_: Exception) {\n      // PiP support is device/launcher dependent; never block Companion startup.\n    }\n  }\n\n  override fun onUserLeaveHint() {\n    super.onUserLeaveHint()\n    if (!mountainViewAlwaysOnTopPip || Build.VERSION.SDK_INT < Build.VERSION_CODES.O || isInPictureInPictureMode) return\n    try {\n      enterPictureInPictureMode(mountainViewPipParams(false))\n    } catch (_: Exception) {\n      // Some vendor launchers can reject a PiP transition during another system dialog.\n    }\n  }\n`;
    source = source.replace(classMarker, block);

    const onCreateMarker = /override fun onCreate\(savedInstanceState: Bundle\?\)\s*\{/;
    if (!onCreateMarker.test(source)) throw new Error('MainActivity onCreate marker missing');
    source = source.replace(onCreateMarker, (match) => `${match}\n    enforceMountainViewAlwaysOnTop()`);

    mod.modResults.contents = source;
    return mod;
  });

  return config;
}

module.exports = createRunOncePlugin(withAlwaysOnTopPip, 'with-always-on-top-pip', '1.0.0');
