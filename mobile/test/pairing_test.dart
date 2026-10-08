// Pairing QR code parsing and the saved connection (pure Dart).
import 'package:flutter_test/flutter_test.dart';
import 'package:girllm_mobile/src/pairing/pairing.dart';

/// Exactly what the PC's `pairingPayload()` produces (URLSearchParams
/// encodes the comma between addresses as %2C).
const _fromServer = 'girllm://pair?v=1&a=192.168.1.20%2C10.0.0.5&p=3211&c=ABCDEFGHJKLMNPQR'
    '&f=abababababababababababababababababababababababababababababababab';

void main() {
  group('PairingInfo.parse', () {
    test('reads the PC payload', () {
      final info = PairingInfo.parse(_fromServer);
      expect(info.addresses, ['192.168.1.20', '10.0.0.5']);
      expect(info.port, 3211);
      expect(info.code, 'ABCDEFGHJKLMNPQR');
      expect(info.fingerprint, 'ab' * 32);
    });

    test('refuses public addresses (never leaves the local network)', () {
      expect(() => PairingInfo.parse(_fromServer.replaceFirst('192.168.1.20', '8.8.8.8')), throwsFormatException);
    });

    test('refuses anything that is not a girllm code', () {
      for (final text in [
        'https://example.com/pair?v=1',
        'girllm://other?v=1',
        _fromServer.replaceFirst('v=1', 'v=2'),
        _fromServer.replaceFirst('p=3211', 'p=80'),
        _fromServer.replaceFirst('c=ABCDEFGHJKLMNPQR', 'c=abc'),
        _fromServer.replaceFirst('f=ab', 'f=zz'),
      ]) {
        expect(() => PairingInfo.parse(text), throwsFormatException, reason: text);
      }
    });
  });

  test('isPrivateIPv4', () {
    for (final ip in ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10']) {
      expect(isPrivateIPv4(ip), isTrue, reason: ip);
    }
    for (final ip in ['172.32.0.1', '8.8.8.8', '127.0.0.1', '192.169.0.1', '10.0.0', '10.0.0.256', 'pc.local']) {
      expect(isPrivateIPv4(ip), isFalse, reason: ip);
    }
  });

  group('Connection', () {
    final connection = Connection(
      addresses: ['192.168.1.20', '10.0.0.5'],
      port: 3211,
      fingerprint: 'ab' * 32,
      token: 'x' * 43,
    );

    test('round-trips through storage', () {
      final back = Connection.fromJson(connection.toJson())!;
      expect(back.addresses, connection.addresses);
      expect(back.port, 3211);
      expect(back.fingerprint, connection.fingerprint);
      expect(back.token, connection.token);
    });

    test('puts the address that worked first', () {
      expect(connection.preferring('10.0.0.5').addresses, ['10.0.0.5', '192.168.1.20']);
    });

    test('a damaged or tampered value means pairing again', () {
      expect(Connection.fromJson(null), isNull);
      expect(Connection.fromJson('not json'), isNull);
      expect(Connection.fromJson(connection.toJson().replaceFirst('192.168.1.20', '1.1.1.1')), isNull);
    });
  });
}
