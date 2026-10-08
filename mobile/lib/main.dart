/// girllm on your phone (step 8).
///
/// The phone talks to ONE machine: your PC, on your local network, over
/// HTTPS with the PC's certificate pinned (from the pairing QR code), with a
/// token only this phone has. No other server, no analytics, no cloud.
library;

import 'package:flutter/material.dart';

import 'src/api/girllm_api.dart';
import 'src/pairing/pair_screen.dart';
import 'src/pairing/pairing.dart';
import 'src/services.dart';
import 'src/ui/characters_screen.dart';
import 'src/ui/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const GirllmApp());
}

class GirllmApp extends StatefulWidget {
  const GirllmApp({super.key});

  @override
  State<GirllmApp> createState() => _GirllmAppState();
}

class _GirllmAppState extends State<GirllmApp> {
  final ConnectionStore _store = ConnectionStore();
  Services? _services;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final connection = await _store.load();
    if (!mounted) return;
    setState(() {
      _services = connection == null ? null : _servicesFor(connection);
      _loading = false;
    });
  }

  Services _servicesFor(Connection connection) =>
      Services(api: GirllmApi(connection), store: _store, onUnpaired: _unpair);

  Future<void> _paired(Connection connection) async {
    await _store.save(connection);
    if (!mounted) return;
    setState(() => _services = _servicesFor(connection));
  }

  Future<void> _unpair() async {
    final old = _services;
    await _store.clear();
    if (!mounted) return;
    setState(() => _services = null);
    await old?.dispose();
  }

  @override
  void dispose() {
    _services?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final services = _services;
    final Widget home;
    if (_loading) {
      home = const Scaffold(body: Center(child: CircularProgressIndicator()));
    } else if (services == null) {
      home = PairScreen(onPaired: _paired);
    } else {
      home = const CharactersScreen();
    }
    return GirllmShell(services: services, home: home);
  }
}

/// The app around its screens. [ServicesScope] must sit ABOVE the
/// [MaterialApp]: screens opened with `Navigator.push` (chat, editor,
/// dialogs) are siblings of `home` inside the navigator, not its children,
/// so a scope placed around `home` alone is invisible to them.
class GirllmShell extends StatelessWidget {
  const GirllmShell({super.key, required this.services, required this.home});

  /// null while not paired (the pairing screen needs no services).
  final Services? services;
  final Widget home;

  @override
  Widget build(BuildContext context) {
    final services = this.services;
    final app = MaterialApp(
      // A new navigator (empty history) on pairing / unpairing.
      key: ValueKey(services),
      title: 'girllm',
      theme: girllmTheme(Brightness.light),
      darkTheme: girllmTheme(Brightness.dark),
      themeMode: ThemeMode.dark,
      debugShowCheckedModeBanner: false,
      home: home,
    );
    return services == null ? app : ServicesScope(services: services, child: app);
  }
}
