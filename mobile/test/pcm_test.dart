// Recorded voice conversion (pure Dart).
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:girllm_mobile/src/audio/pcm.dart';

void main() {
  test('16-bit PCM to float32 little-endian in [-1, 1]', () {
    final pcm = ByteData(8)
      ..setInt16(0, 0, Endian.little)
      ..setInt16(2, 16384, Endian.little)
      ..setInt16(4, -32768, Endian.little)
      ..setInt16(6, 32767, Endian.little);
    final out = ByteData.sublistView(pcm16ToFloat32Le(pcm.buffer.asUint8List()));
    expect(out.lengthInBytes, 16);
    expect(out.getFloat32(0, Endian.little), 0);
    expect(out.getFloat32(4, Endian.little), 0.5);
    expect(out.getFloat32(8, Endian.little), -1);
    expect(out.getFloat32(12, Endian.little), closeTo(1, 1e-4));
  });

  test('an odd trailing byte is dropped', () {
    expect(pcm16ToFloat32Le(Uint8List(5)).length, 8);
  });

  test('duration', () {
    expect(pcm16Seconds(48000, 24000), 1);
  });
}
