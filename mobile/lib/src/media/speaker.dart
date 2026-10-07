/// Plays her voice: the PC generates the FLAC (or replays it from its
/// cache), the phone writes it to a temporary file and plays it. One message
/// at a time; [loading] / [playing] say which one (for its 🔊 button).
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';

class Speaker {
  final AudioPlayer _player = AudioPlayer();

  /// Message being prepared on the PC (GPU), or null.
  final ValueNotifier<String?> loading = ValueNotifier(null);

  /// Message being played, or null.
  final ValueNotifier<String?> playing = ValueNotifier(null);

  /// Bumped by [stop] and each new message: late answers are dropped.
  int _generation = 0;
  File? _file;

  /// Say a message: [fetch] gets its audio from the PC.
  Future<void> speak(String messageId, Future<Uint8List?> Function() fetch) async {
    await stop();
    final generation = ++_generation;
    loading.value = messageId;
    try {
      final audio = await fetch();
      if (generation != _generation || audio == null) return;
      final dir = await getTemporaryDirectory();
      final file = File('${dir.path}/girllm_voice_$generation.flac');
      await file.writeAsBytes(audio, flush: true);
      await _deleteFile();
      _file = file;
      if (generation != _generation) return;
      await _player.setFilePath(file.path);
      loading.value = null;
      playing.value = messageId;
      await _player.play(); // completes when playback ends or is stopped
    } finally {
      if (generation == _generation) {
        loading.value = null;
        playing.value = null;
      }
    }
  }

  /// Silence now (and forget what is being prepared).
  Future<void> stop() async {
    _generation++;
    loading.value = null;
    playing.value = null;
    await _player.stop();
  }

  Future<void> _deleteFile() async {
    final old = _file;
    _file = null;
    if (old != null && await old.exists()) await old.delete();
  }

  Future<void> dispose() async {
    await stop();
    await _deleteFile();
    await _player.dispose();
    loading.dispose();
    playing.dispose();
  }
}
