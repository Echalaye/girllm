// The picture cache: shared downloads, few at a time, failures not kept.
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:girllm_mobile/src/media/remote_image.dart';

void main() {
  test('one download per picture, whoever asks', () async {
    final cache = PictureCache();
    var loads = 0;
    Future<Uint8List?> load() async {
      loads++;
      return Uint8List(1);
    }

    final a = cache.get('img:1', load);
    final b = cache.get('img:1', load);
    expect(identical(a, b), isTrue);
    await a;
    expect(loads, 1);
  });

  test('at most maxConcurrent downloads at once, the others wait their turn', () async {
    final cache = PictureCache(maxConcurrent: 2);
    var running = 0;
    var peak = 0;
    final gates = List.generate(5, (_) => Completer<void>());
    final futures = [
      for (var i = 0; i < 5; i++)
        cache.get('img:$i', () async {
          running++;
          peak = running > peak ? running : peak;
          await gates[i].future;
          running--;
          return Uint8List(1);
        }),
    ];
    await pumpEventQueue();
    expect(running, 2);
    for (final gate in gates) {
      gate.complete();
      await pumpEventQueue();
    }
    await Future.wait(futures);
    expect(peak, 2);
  });

  test('a failed download is forgotten, so the next ask retries', () async {
    final cache = PictureCache();
    var attempt = 0;
    Future<Uint8List?> load() async {
      attempt++;
      if (attempt == 1) throw Exception('Wi-Fi hiccup');
      return Uint8List(1);
    }

    await expectLater(cache.get('img:1', load), throwsException);
    expect(await cache.get('img:1', load), isNotNull);
    expect(attempt, 2);
  });

  test('keeps only the most recent pictures', () async {
    final cache = PictureCache(maxEntries: 2);
    var loads = 0;
    Future<Uint8List?> load() async {
      loads++;
      return Uint8List(1);
    }

    await cache.get('a', load);
    await cache.get('b', load);
    await cache.get('a', load); // a is now the most recent
    await cache.get('c', load); // evicts b
    await cache.get('a', load);
    expect(loads, 3);
    await cache.get('b', load);
    expect(loads, 4);
  });
}
