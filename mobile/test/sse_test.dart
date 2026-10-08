// Server-Sent Events parsing of her reply stream (pure Dart).
import 'package:flutter_test/flutter_test.dart';
import 'package:girllm_mobile/src/api/sse.dart';

List<SseEvent> _parse(String text) {
  final parser = SseParser();
  return [
    for (final line in text.split('\n')) ?parser.add(line),
  ];
}

void main() {
  test('reads named events with JSON data', () {
    final events = _parse('event: token\ndata: {"text":"Hi"}\n\nevent: done\ndata: {"messageId":"m1"}\n\n');
    expect(events.map((e) => e.event), ['token', 'done']);
    expect(events[0].data['text'], 'Hi');
    expect(events[1].data['messageId'], 'm1');
  });

  test('ignores comments (keep-alives) and blank lines between events', () {
    final events = _parse(': ping\n\n\nevent: token\ndata: {"text":"a"}\n\n');
    expect(events, hasLength(1));
  });

  test('joins multi-line data, and non-JSON data gives an empty map', () {
    final multi = _parse('event: token\ndata: {"text":\ndata: "x"}\n\n');
    expect(multi.single.data['text'], 'x');
    expect(_parse('data: hello\n\n').single.data, isEmpty);
    expect(_parse('data: hello\n\n').single.event, 'message');
  });
}
