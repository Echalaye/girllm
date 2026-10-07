/// Home: your characters. Tap one to chat; the pencil opens the editor.
library;

import 'package:flutter/material.dart';

import '../api/pinned_client.dart';
import '../media/remote_image.dart';
import '../models.dart';
import '../services.dart';
import 'chat_screen.dart';
import 'editor_screen.dart';
import 'theme.dart';

class CharactersScreen extends StatefulWidget {
  const CharactersScreen({super.key});

  @override
  State<CharactersScreen> createState() => _CharactersScreenState();
}

class _CharactersScreenState extends State<CharactersScreen> {
  late Future<List<CharacterSummary>> _characters;

  /// Bumped after an edit: faces are fetched again.
  int _bust = 0;

  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return; // once: the services don't change while paired
    _started = true;
    _characters = _load();
  }

  Future<List<CharacterSummary>> _load() async {
    final api = ServicesScope.of(context).api;
    await api.connect(); // finds the PC on whichever address answers
    return api.characters();
  }

  void _reload() => setState(() {
        _bust++;
        _characters = _load();
      });

  Future<void> _openEditor(String? id) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => EditorScreen(characterId: id)));
    if (mounted) _reload();
  }

  Future<void> _confirmUnpair() async {
    final services = ServicesScope.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Unpair this phone?'),
        content: const Text('The phone forgets your PC. To use it again, scan a new QR code from the PC settings.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Unpair')),
        ],
      ),
    );
    if (ok == true) await services.onUnpaired();
  }

  @override
  Widget build(BuildContext context) {
    final services = ServicesScope.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('girllm'),
        actions: [
          IconButton(onPressed: _reload, icon: const Icon(Icons.refresh), tooltip: 'Refresh'),
          PopupMenuButton<String>(
            onSelected: (value) {
              if (value == 'unpair') _confirmUnpair();
            },
            itemBuilder: (_) => const [PopupMenuItem(value: 'unpair', child: Text('Unpair this phone'))],
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openEditor(null),
        icon: const Icon(Icons.person_add_alt),
        label: const Text('New character'),
      ),
      body: FutureBuilder<List<CharacterSummary>>(
        future: _characters,
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return _ErrorView(error: snapshot.error!, onRetry: _reload, onUnpair: services.onUnpaired);
          }
          final list = snapshot.data;
          if (list == null) return const Center(child: CircularProgressIndicator());
          if (list.isEmpty) return const Center(child: Text('No character yet: create one.'));
          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: ListView.separated(
              padding: const EdgeInsets.only(bottom: 96),
              itemCount: list.length,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final c = list[i];
                return ListTile(
                  leading: _Avatar(character: c, bust: _bust),
                  title: Text(c.name),
                  subtitle: Text(c.style == 'texting' ? 'Text messages' : 'Roleplay'),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(builder: (_) => ChatScreen(character: c)),
                  ),
                  trailing: IconButton(
                    icon: const Icon(Icons.edit_outlined),
                    tooltip: 'Edit ${c.name}',
                    onPressed: () => _openEditor(c.id),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.character, required this.bust});

  final CharacterSummary character;
  final int bust;

  @override
  Widget build(BuildContext context) {
    final services = ServicesScope.of(context);
    final initial = Text(character.name.isEmpty ? '?' : character.name.characters.first.toUpperCase());
    return CircleAvatar(
      radius: 24,
      backgroundColor: GirllmColors.dusk2,
      child: !character.hasFace
          ? initial
          : ClipOval(
              child: SizedBox.expand(
                child: RemoteImage(
                  cacheKey: 'face:${character.id}:$bust',
                  cache: services.pictures,
                  load: () => services.api.picture(character.id, 'face'),
                  placeholder: initial,
                  semanticLabel: character.name,
                ),
              ),
            ),
    );
  }
}

/// Can't reach the PC / not paired any more: say what to do.
class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.error, required this.onRetry, required this.onUnpair});

  final Object error;
  final VoidCallback onRetry;
  final Future<void> Function() onUnpair;

  @override
  Widget build(BuildContext context) {
    final notPaired = error is ApiException && (error as ApiException).notPaired;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(notPaired ? Icons.link_off : Icons.wifi_off, size: 48),
            const SizedBox(height: 12),
            Text(notPaired ? 'This phone was removed on the PC.' : error.toString(), textAlign: TextAlign.center),
            const SizedBox(height: 16),
            if (notPaired)
              FilledButton(onPressed: onUnpair, child: const Text('Pair again'))
            else
              FilledButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}
