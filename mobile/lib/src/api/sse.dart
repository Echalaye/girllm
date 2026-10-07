/// Server-Sent Events over a POST response (girllm's reply stream):
///
///   event: token   data: {"text": "..."}
///   event: done    data: {"messageId": "...", ...}
///   event: photo_start / photo / photo_error / error
///
/// Pure Dart (unit-tested): feed it the response line by line.
library;

import 'dart:convert';

/// One event of the stream.
class SseEvent {
  const SseEvent(this.event, this.data);

  final String event;

  /// The JSON object of the `data:` lines (empty when it isn't one).
  final Map<String, dynamic> data;

  @override
  String toString() => 'SseEvent($event, $data)';
}

/// Incremental parser: [add] each line (without its line break); a complete
/// event comes out on the blank line that ends it.
class SseParser {
  String _event = 'message';
  final StringBuffer _data = StringBuffer();
  bool _hasData = false;

  /// Returns the event a blank line completes, or null.
  SseEvent? add(String line) {
    if (line.isEmpty) {
      if (!_hasData) {
        _event = 'message';
        return null;
      }
      final event = SseEvent(_event, _decode(_data.toString()));
      _event = 'message';
      _data.clear();
      _hasData = false;
      return event;
    }
    if (line.startsWith(':')) return null; // comment / keep-alive
    final colon = line.indexOf(':');
    final field = colon < 0 ? line : line.substring(0, colon);
    var value = colon < 0 ? '' : line.substring(colon + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'event':
        _event = value;
      case 'data':
        if (_hasData) _data.write('\n');
        _data.write(value);
        _hasData = true;
    }
    return null;
  }

  static Map<String, dynamic> _decode(String text) {
    try {
      final value = jsonDecode(text);
      return value is Map<String, dynamic> ? value : <String, dynamic>{};
    } on FormatException {
      return <String, dynamic>{};
    }
  }
}
