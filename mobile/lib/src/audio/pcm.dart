/// Audio conversion for the voice you record for her (pure Dart, tested).
library;

import 'dart:typed_data';

/// 16-bit little-endian mono PCM (what the recorder streams) to the
/// little-endian float32 samples the PC expects, in [-1, 1].
Uint8List pcm16ToFloat32Le(Uint8List pcm) {
  final input = ByteData.sublistView(pcm);
  final count = pcm.length ~/ 2; // an odd trailing byte is dropped
  final output = ByteData(count * 4);
  for (var i = 0; i < count; i++) {
    output.setFloat32(i * 4, input.getInt16(i * 2, Endian.little) / 32768.0, Endian.little);
  }
  return output.buffer.asUint8List();
}

/// Seconds of audio in 16-bit mono PCM at [sampleRate].
double pcm16Seconds(int byteLength, int sampleRate) => byteLength / 2 / sampleRate;
