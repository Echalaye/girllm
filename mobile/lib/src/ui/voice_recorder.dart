/// Records a voice for a character (step 7b on the phone): the person reads a
/// short text aloud, the phone records raw 16-bit PCM at 24 kHz mono and
/// hands it back. Nothing is saved on the phone; the editor sends it to the PC.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:record/record.dart';

import '../audio/pcm.dart';

/// The rate the PC's voice model works at: no resampling needed.
const voiceSampleRate = 24000;

/// Same limits as the PC (it checks them again after trimming silences).
const _minSeconds = 4;
const _maxSeconds = 30;

/// Ask whether the voice may be used. Returns true when the person confirms.
Future<bool> confirmVoiceConsent(BuildContext context) async {
  var agreed = false;
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => AlertDialog(
        title: const Text('Whose voice is it?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Only use your own voice, or the voice of an adult who agreed to it. '
              'The recording stays on your PC.',
            ),
            const SizedBox(height: 12),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: agreed,
              onChanged: (v) => setState(() => agreed = v ?? false),
              title: const Text('This is my voice, or the voice of an adult who agreed to it'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: agreed ? () => Navigator.pop(context, true) : null, child: const Text('Continue')),
        ],
      ),
    ),
  );
  return ok ?? false;
}

/// Shows the recorder. Returns the 16-bit PCM (24 kHz mono), or null.
Future<Uint8List?> recordVoice(BuildContext context, {required String textToRead}) =>
    showDialog<Uint8List>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _RecorderDialog(textToRead: textToRead),
    );

class _RecorderDialog extends StatefulWidget {
  const _RecorderDialog({required this.textToRead});

  final String textToRead;

  @override
  State<_RecorderDialog> createState() => _RecorderDialogState();
}

class _RecorderDialogState extends State<_RecorderDialog> {
  final AudioRecorder _recorder = AudioRecorder();
  final BytesBuilder _pcm = BytesBuilder(copy: false);
  StreamSubscription<Uint8List>? _subscription;
  Timer? _ticker;
  bool _recording = false;
  String? _error;

  double get _seconds => pcm16Seconds(_pcm.length, voiceSampleRate);

  @override
  void dispose() {
    _ticker?.cancel();
    unawaited(_subscription?.cancel());
    unawaited(_recorder.dispose()); // also stops a running recording
    super.dispose();
  }

  Future<void> _start() async {
    // Asks for the microphone permission the first time.
    if (!await _recorder.hasPermission()) {
      setState(() => _error = 'girllm needs the microphone to record. Allow it in Android settings.');
      return;
    }
    _pcm.clear();
    try {
      final stream = await _recorder.startStream(
        const RecordConfig(encoder: AudioEncoder.pcm16bits, sampleRate: voiceSampleRate, numChannels: 1),
      );
      _subscription = stream.listen(_pcm.add);
    } on Object catch (e) {
      setState(() => _error = 'Could not start recording: $e');
      return;
    }
    _ticker = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (!mounted) return;
      if (_seconds >= _maxSeconds) {
        unawaited(_stop());
      } else {
        setState(() {});
      }
    });
    setState(() {
      _recording = true;
      _error = null;
    });
  }

  Future<void> _stop() async {
    if (!_recording) return;
    _ticker?.cancel();
    await _recorder.stop();
    await _subscription?.cancel();
    _subscription = null;
    if (!mounted) return;
    setState(() => _recording = false);
    if (_seconds < _minSeconds) {
      setState(() => _error = 'Too short: read the whole text (at least $_minSeconds seconds).');
      return;
    }
    Navigator.pop(context, _pcm.takeBytes());
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AlertDialog(
      title: const Text('Record a voice'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('In a quiet room, read this aloud in a natural voice:'),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(widget.textToRead, style: theme.textTheme.bodyLarge),
          ),
          const SizedBox(height: 12),
          if (_recording) ...[
            LinearProgressIndicator(value: (_seconds / _maxSeconds).clamp(0.0, 1.0)),
            const SizedBox(height: 6),
            Text('Recording… ${_seconds.toStringAsFixed(0)} s / $_maxSeconds s'),
          ],
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
            ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        _recording
            ? FilledButton.icon(onPressed: _stop, icon: const Icon(Icons.stop), label: const Text('Done'))
            : FilledButton.icon(onPressed: _start, icon: const Icon(Icons.mic), label: const Text('Start')),
      ],
    );
  }
}
