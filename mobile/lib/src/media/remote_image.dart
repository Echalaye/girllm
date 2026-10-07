/// Pictures from the PC (her photos, faces, backgrounds). Flutter's
/// Image.network can't use the pinned client, so bytes are fetched with it
/// and shown with Image.memory, through a small in-memory cache.
library;

import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'package:flutter/material.dart';

/// Least-recently-used cache of picture bytes (photos are ~1–3 MB).
class PictureCache {
  PictureCache({this.maxEntries = 30});

  final int maxEntries;
  final LinkedHashMap<String, Future<Uint8List?>> _entries = LinkedHashMap();

  Future<Uint8List?> get(String key, Future<Uint8List?> Function() load) {
    final hit = _entries.remove(key);
    if (hit != null) {
      _entries[key] = hit; // most recent last
      return hit;
    }
    final future = load();
    _entries[key] = future;
    // A failed load is not cached (the error itself goes to the widget).
    unawaited(
      future.then<void>(
        (_) {},
        onError: (Object _) {
          _entries.remove(key);
        },
      ),
    );
    while (_entries.length > maxEntries) {
      _entries.remove(_entries.keys.first);
    }
    return future;
  }

  void evict(String key) => _entries.remove(key);
}

/// A picture loaded from the PC.
class RemoteImage extends StatelessWidget {
  const RemoteImage({
    super.key,
    required this.cacheKey,
    required this.cache,
    required this.load,
    this.fit = BoxFit.cover,
    this.placeholder,
    this.semanticLabel,
  });

  final String cacheKey;
  final PictureCache cache;
  final Future<Uint8List?> Function() load;
  final BoxFit fit;
  final Widget? placeholder;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Uint8List?>(
      future: cache.get(cacheKey, load),
      builder: (context, snapshot) {
        final bytes = snapshot.data;
        if (bytes != null) {
          return Image.memory(bytes, fit: fit, gaplessPlayback: true, semanticLabel: semanticLabel);
        }
        if (snapshot.hasError) {
          return placeholder ?? const Center(child: Icon(Icons.broken_image_outlined));
        }
        return placeholder ?? const Center(child: CircularProgressIndicator(strokeWidth: 2));
      },
    );
  }
}
