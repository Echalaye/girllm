/// HTTPS to your PC only, with its certificate PINNED.
///
/// The client trusts no certificate authority at all
/// (`SecurityContext(withTrustedRoots: false)`): every certificate goes
/// through [HttpClient.badCertificateCallback], which accepts exactly one,
/// the PC's, by its SHA-256 from the pairing QR code. Requests never go
/// through a proxy, and only to the PC's private-network addresses.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import 'sse.dart';

/// An error answered by the PC (its message is meant for the user).
class ApiException implements Exception {
  const ApiException(this.status, this.message);

  final int status;
  final String message;

  /// The phone was removed on the PC, or the pairing was lost.
  bool get notPaired => status == 401;

  @override
  String toString() => message;
}

/// The PC could not be reached on any of its addresses.
class UnreachableException implements Exception {
  const UnreachableException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// Lets the user stop a running request (her reply, a photo).
class CancelToken {
  HttpClientRequest? _request;
  bool _cancelled = false;

  bool get isCancelled => _cancelled;

  void cancel() {
    _cancelled = true;
    _request?.abort();
  }
}

class PinnedClient {
  PinnedClient({required List<String> addresses, required this.port, required this.fingerprint, this.token})
      : _addresses = List.of(addresses) {
    // Plain statements, not a cascade: an arrow function inside a cascade
    // would swallow the following `..setters`.
    final http = HttpClient(context: SecurityContext(withTrustedRoots: false));
    // Only the PC's own certificate: compared byte for byte by its hash.
    http.badCertificateCallback = (cert, host, port) => sha256.convert(cert.der).toString() == fingerprint;
    // Local network only: never a system or Wi-Fi proxy.
    http.findProxy = (_) => 'DIRECT';
    http.connectionTimeout = const Duration(seconds: 6);
    http.idleTimeout = const Duration(seconds: 20);
    http.userAgent = 'girllm-mobile';
    _http = http;
  }

  late final HttpClient _http;
  final List<String> _addresses;
  final int port;
  final String fingerprint;

  /// This phone's token (null only while pairing).
  String? token;

  /// The address in use (the first one that answered).
  String get address => _addresses.first;

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri(scheme: 'https', host: address, port: port, path: path, queryParameters: query);

  /// Find an address that answers (Wi-Fi addresses can change): tries each
  /// one with [probe] and keeps the first that works.
  Future<void> connect(Future<void> Function() probe) async {
    Object? last;
    for (var i = 0; i < _addresses.length; i++) {
      try {
        await probe();
        return;
      } on SocketException catch (e) {
        last = e;
      } on TimeoutException catch (e) {
        last = e;
      } on HandshakeException {
        throw const UnreachableException(
          "Your PC's certificate is not the one this phone was paired with. Pair again from the PC settings.",
        );
      }
      _addresses.add(_addresses.removeAt(0)); // next address first
    }
    throw UnreachableException(
      'Your PC is not reachable on ${_addresses.join(', ')} (port $port). Is it on, with girllm running, and is this '
      'phone on the same Wi-Fi? ${last ?? ''}'.trim(),
    );
  }

  /// Send a request; throws [ApiException] for an error answer.
  Future<HttpClientResponse> send(
    String method,
    String path, {
    Object? json,
    Uint8List? bytes,
    Map<String, String>? query,
    Map<String, String>? headers,
    CancelToken? cancel,
  }) async {
    final request = await _http.openUrl(method, _uri(path, query));
    cancel?._request = request;
    if (cancel?.isCancelled ?? false) request.abort();
    final t = token;
    if (t != null) request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $t');
    headers?.forEach(request.headers.set);
    if (json != null) {
      request.headers.contentType = ContentType.json;
      request.add(utf8.encode(jsonEncode(json)));
    } else if (bytes != null) {
      request.headers.contentType = ContentType('application', 'octet-stream');
      request.add(bytes);
    }
    final response = await request.close();
    if (response.statusCode >= 400) throw await _error(response);
    return response;
  }

  /// JSON answer (null for 204 No Content).
  Future<Object?> json(String method, String path, {Object? body, Map<String, String>? headers, Uint8List? bytes, Map<String, String>? query, CancelToken? cancel}) async {
    final response = await send(method, path, json: body, headers: headers, bytes: bytes, query: query, cancel: cancel);
    if (response.statusCode == 204) {
      await response.drain<void>();
      return null;
    }
    final text = await response.transform(utf8.decoder).join();
    return text.isEmpty ? null : jsonDecode(text);
  }

  /// Binary answer (images, audio), or null for 204.
  Future<Uint8List?> bytes(String method, String path, {Object? body, CancelToken? cancel}) async {
    final response = await send(method, path, json: body, cancel: cancel);
    if (response.statusCode == 204) {
      await response.drain<void>();
      return null;
    }
    return consolidateHttpClientResponseBytes(response);
  }

  /// Her reply as it is written (POST answered with Server-Sent Events).
  /// Ends without events on 204 (she doesn't write first right now).
  Stream<SseEvent> events(String path, Object body, {CancelToken? cancel}) async* {
    final response = await send(
      'POST',
      path,
      json: body,
      headers: {HttpHeaders.acceptHeader: 'text/event-stream'},
      cancel: cancel,
    );
    if (response.statusCode == 204) {
      await response.drain<void>();
      return;
    }
    final parser = SseParser();
    await for (final line in response.transform(utf8.decoder).transform(const LineSplitter())) {
      final event = parser.add(line);
      if (event != null) yield event;
    }
    final last = parser.add(''); // a final event without its blank line
    if (last != null) yield last;
  }

  static Future<ApiException> _error(HttpClientResponse response) async {
    final text = await response.transform(utf8.decoder).join().catchError((Object _) => '');
    var message = 'Error ${response.statusCode}';
    try {
      final body = jsonDecode(text);
      if (body is Map<String, dynamic> && body['error'] is String) message = body['error'] as String;
    } on FormatException {
      // not JSON: keep the status
    }
    return ApiException(response.statusCode, message);
  }

  void close() => _http.close(force: true);
}
