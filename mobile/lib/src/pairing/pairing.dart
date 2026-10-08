/// What the phone knows about its PC: read from the pairing QR code, then
/// kept (with the token the PC gave) in the Android Keystore.
///
/// QR code: `girllm://pair?v=1&a=<ip>,<ip>&p=<port>&c=<code>&f=<sha256 hex>`
///
/// Everything is validated: only private-network IPv4 addresses are
/// accepted (the app never talks to anything outside your network), and
/// the certificate fingerprint must be a SHA-256.
library;

import 'dart:convert';

/// The decoded pairing QR code.
class PairingInfo {
  const PairingInfo({required this.addresses, required this.port, required this.code, required this.fingerprint});

  final List<String> addresses;
  final int port;

  /// One-time code (5 minutes) exchanged for this phone's token.
  final String code;

  /// SHA-256 of the PC's TLS certificate, lowercase hex: pinned.
  final String fingerprint;

  /// Parse and validate a scanned text. Throws [FormatException] with a
  /// message for the user when it isn't a girllm pairing code.
  static PairingInfo parse(String text) {
    final uri = Uri.tryParse(text.trim());
    if (uri == null || uri.scheme != 'girllm' || uri.host != 'pair') {
      throw const FormatException('This QR code is not a girllm pairing code.');
    }
    final q = uri.queryParameters;
    if (q['v'] != '1') throw const FormatException('This pairing code needs a newer version of the app.');
    final addresses = (q['a'] ?? '').split(',').map((a) => a.trim()).where((a) => a.isNotEmpty).toList();
    if (addresses.isEmpty || !addresses.every(isPrivateIPv4)) {
      throw const FormatException('The PC address in this code is not on a private network.');
    }
    final port = int.tryParse(q['p'] ?? '');
    if (port == null || port < 1024 || port > 65535) throw const FormatException('Invalid port in this code.');
    final code = q['c'] ?? '';
    if (!RegExp(r'^[A-Z2-7]{16,64}$').hasMatch(code)) throw const FormatException('Invalid pairing code.');
    final fingerprint = (q['f'] ?? '').toLowerCase();
    if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(fingerprint)) throw const FormatException('Invalid certificate fingerprint.');
    return PairingInfo(addresses: addresses, port: port, code: code, fingerprint: fingerprint);
  }
}

/// Is this an IPv4 address of a private network (10/8, 172.16/12, 192.168/16)?
bool isPrivateIPv4(String ip) {
  final parts = ip.split('.');
  if (parts.length != 4) return false;
  final n = parts.map(int.tryParse).toList();
  if (n.any((v) => v == null || v < 0 || v > 255)) return false;
  final a = n[0]!, b = n[1]!;
  return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168);
}

/// The saved connection to the PC (secure storage).
class Connection {
  const Connection({required this.addresses, required this.port, required this.fingerprint, required this.token});

  /// Addresses to try, the one that worked last first.
  final List<String> addresses;
  final int port;
  final String fingerprint;

  /// This phone's bearer token (from the pairing).
  final String token;

  Connection preferring(String address) => Connection(
        addresses: [address, ...addresses.where((a) => a != address)],
        port: port,
        fingerprint: fingerprint,
        token: token,
      );

  String toJson() => jsonEncode({'a': addresses, 'p': port, 'f': fingerprint, 't': token});

  /// Null when the stored value is missing or damaged (the phone pairs again).
  static Connection? fromJson(String? text) {
    if (text == null) return null;
    try {
      final map = jsonDecode(text) as Map<String, dynamic>;
      final addresses = (map['a'] as List<dynamic>).cast<String>();
      final connection = Connection(
        addresses: addresses,
        port: map['p'] as int,
        fingerprint: map['f'] as String,
        token: map['t'] as String,
      );
      final valid = addresses.isNotEmpty &&
          addresses.every(isPrivateIPv4) &&
          RegExp(r'^[0-9a-f]{64}$').hasMatch(connection.fingerprint) &&
          connection.token.length >= 20;
      return valid ? connection : null;
    } on Object {
      return null;
    }
  }
}
