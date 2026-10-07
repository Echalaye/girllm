/// What every screen needs: the API to the PC, her voice player, the picture
/// cache, and the saved connection. Provided once, above the screens.
library;

import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api/girllm_api.dart';
import 'media/remote_image.dart';
import 'media/speaker.dart';
import 'pairing/pairing.dart';

/// The connection in the Android Keystore (encrypted; app backups are off).
class ConnectionStore {
  static const _key = 'girllm.connection';
  final FlutterSecureStorage _storage = FlutterSecureStorage();

  Future<Connection?> load() async => Connection.fromJson(await _storage.read(key: _key));

  Future<void> save(Connection connection) => _storage.write(key: _key, value: connection.toJson());

  Future<void> clear() => _storage.delete(key: _key);
}

class Services {
  Services({required this.api, required this.store, required this.onUnpaired})
      : speaker = Speaker(),
        pictures = PictureCache();

  final GirllmApi api;
  final ConnectionStore store;
  final Speaker speaker;
  final PictureCache pictures;

  /// Forget the PC and go back to the pairing screen.
  final Future<void> Function() onUnpaired;

  Future<void> dispose() async {
    await speaker.dispose();
    api.close();
  }
}

/// Gives the screens access to [Services].
class ServicesScope extends InheritedWidget {
  const ServicesScope({super.key, required this.services, required super.child});

  final Services services;

  static Services of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ServicesScope>()!.services;

  @override
  bool updateShouldNotify(ServicesScope oldWidget) => services != oldWidget.services;
}
