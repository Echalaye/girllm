/// Pictures from the PC (her photos, faces, backgrounds). Flutter's
/// Image.network can't use the pinned client, so bytes are fetched with it
/// and shown with Image.memory, through a small in-memory cache.
library;

import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'package:flutter/material.dart';

/// Least-recently-used cache of picture bytes (photos are ~1–3 MB).
///
/// At most [maxConcurrent] downloads run at once: opening a chat with many
/// photos must not open a dozen parallel connections over Wi-Fi (they would
/// all be slow, and the first photos on screen would come last).
class PictureCache {
  PictureCache({this.maxEntries = 30, this.maxConcurrent = 3});

  final int maxEntries;
  final int maxConcurrent;
  final LinkedHashMap<String, Future<Uint8List?>> _entries = LinkedHashMap();

  int _running = 0;
  final Queue<Completer<void>> _waiting = Queue();

  Future<Uint8List?> get(String key, Future<Uint8List?> Function() load) {
    final hit = _entries.remove(key);
    if (hit != null) {
      _entries[key] = hit; // most recent last
      return hit;
    }
    final future = _limited(load);
    _entries[key] = future;
    // A failed load is not cached (the error itself goes to the widget, which
    // offers to retry).
    unawaited(
      future.then<void>(
        (_) {},
        onError: (Object _) {
          if (identical(_entries[key], future)) _entries.remove(key);
        },
      ),
    );
    while (_entries.length > maxEntries) {
      _entries.remove(_entries.keys.first);
    }
    return future;
  }

  void evict(String key) => _entries.remove(key);

  /// Runs [load] when one of the [maxConcurrent] slots is free.
  Future<Uint8List?> _limited(Future<Uint8List?> Function() load) async {
    if (_running >= maxConcurrent) {
      final turn = Completer<void>();
      _waiting.add(turn);
      await turn.future;
    }
    _running++;
    try {
      return await load();
    } finally {
      _running--;
      if (_waiting.isNotEmpty) _waiting.removeFirst().complete();
    }
  }
}

/// A picture loaded from the PC. While loading: [placeholder] (or a small
/// spinner). If it can't be loaded: an icon, the reason, and tap to retry.
class RemoteImage extends StatefulWidget {
  const RemoteImage({
    super.key,
    required this.cacheKey,
    required this.cache,
    required this.load,
    this.fit = BoxFit.cover,
    this.placeholder,
    this.semanticLabel,
    this.decodeWidth,
    this.showError = true,
  });

  final String cacheKey;
  final PictureCache cache;
  final Future<Uint8List?> Function() load;
  final BoxFit fit;
  final Widget? placeholder;
  final String? semanticLabel;

  /// Decode at this width (logical pixels; scaled by the screen density) to
  /// save memory: a 1024×1536 photo shown 300 px wide doesn't need 6 MB.
  final double? decodeWidth;

  /// false: a failed picture shows the placeholder (avatars, backgrounds).
  final bool showError;

  @override
  State<RemoteImage> createState() => _RemoteImageState();
}

class _RemoteImageState extends State<RemoteImage> {
  void _retry() {
    widget.cache.evict(widget.cacheKey);
    setState(() {}); // build() asks the cache again: a new download
  }

  @override
  Widget build(BuildContext context) {
    final width = widget.decodeWidth;
    final cacheWidth = width == null ? null : (width * MediaQuery.devicePixelRatioOf(context)).round();
    return FutureBuilder<Uint8List?>(
      future: widget.cache.get(widget.cacheKey, widget.load),
      builder: (context, snapshot) {
        final bytes = snapshot.data;
        if (bytes != null) {
          return Image.memory(
            bytes,
            fit: widget.fit,
            gaplessPlayback: true,
            cacheWidth: cacheWidth,
            semanticLabel: widget.semanticLabel,
            errorBuilder: (context, error, _) => _failure('This picture is damaged'),
          );
        }
        if (snapshot.hasError || snapshot.connectionState == ConnectionState.done) {
          // done without bytes: the PC has no such picture (any more).
          if (!widget.showError) return widget.placeholder ?? const SizedBox.shrink();
          return _failure(snapshot.hasError ? '${snapshot.error}' : 'Not on the PC any more');
        }
        return widget.placeholder ?? const Center(child: CircularProgressIndicator(strokeWidth: 2));
      },
    );
  }

  Widget _failure(String reason) => InkWell(
        onTap: _retry,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.broken_image_outlined),
              const SizedBox(height: 4),
              Text(
                "Couldn't load this picture (tap to retry)\n$reason",
                textAlign: TextAlign.center,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      );
}
