/// Character editor (same card as the PC page): her card, her voice (design
/// it from a description or record a real one, with consent), and her face
/// and background pictures (generate and pick, or upload a face, with consent).
///
/// The full card loaded from the PC is kept and sent back, so fields the
/// phone doesn't show (her lorebook…) are never lost.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../api/pinned_client.dart';
import '../audio/pcm.dart';
import '../media/remote_image.dart';
import '../models.dart';
import '../services.dart';
import 'theme.dart';
import 'voice_recorder.dart';

/// Shown as placeholders, like on the PC page.
const _voiceHints = {
  'female': 'Woman in her late twenties, warm and slightly husky voice, calm, a little playful, speaks softly',
  'male': 'Man in his late twenties, deep and calm voice, slightly husky, relaxed, speaks slowly',
};

/// A text field of the card: key, label, lines, max length (as on the PC).
typedef _Field = ({String key, String label, int lines, int max});

const List<_Field> _mainFields = [
  (key: 'name', label: 'Name', lines: 1, max: 100),
  (key: 'description', label: 'Description', lines: 6, max: 20000),
  (key: 'personality', label: 'Personality', lines: 3, max: 5000),
  (key: 'scenario', label: 'Scenario', lines: 3, max: 5000),
  (key: 'first_mes', label: 'First message', lines: 4, max: 10000),
];

const List<_Field> _advancedFields = [
  (key: 'mes_example', label: 'Example messages', lines: 4, max: 20000),
  (key: 'system_prompt', label: 'System prompt', lines: 3, max: 10000),
  (key: 'post_history_instructions', label: 'Post-history instructions', lines: 3, max: 5000),
  (key: 'creator_notes', label: 'Creator notes', lines: 3, max: 10000),
];

const List<_Field> _voiceFields = [(key: 'voiceDescription', label: 'What the voice sounds like', lines: 3, max: 500)];
const List<_Field> _pictureFields = [
  (key: 'appearance', label: 'Appearance in pictures', lines: 3, max: 500),
  (key: 'backgroundScene', label: 'Background scene (empty: imagined from the card)', lines: 2, max: 1000),
];

class EditorScreen extends StatefulWidget {
  /// null: a new character.
  const EditorScreen({super.key, required this.characterId});

  final String? characterId;

  @override
  State<EditorScreen> createState() => _EditorScreenState();
}

class _EditorScreenState extends State<EditorScreen> {
  late Services _services;
  bool _started = false;

  String? _id;
  Map<String, dynamic> _card = {};
  final Map<String, TextEditingController> _text = {
    for (final f in [..._mainFields, ..._advancedFields, ..._voiceFields, ..._pictureFields])
      f.key: TextEditingController(),
  };
  final TextEditingController _tags = TextEditingController();

  String _style = 'roleplay';
  String _gender = 'female';
  String _artStyle = 'realistic';
  String _background = 'scene';

  /// The card as last loaded/saved: leaving with other values asks first.
  String _savedJson = '';
  bool _loading = true;
  bool _saving = false;
  String? _error;

  bool _hasVoice = false;
  bool _speaks = false;
  String _voiceReason = '';
  String _readAloud = '';
  bool _photos = false;

  /// Bumped when her voice / pictures change: fetched again.
  int _bust = 0;

  /// Running GPU requests (closing the editor cancels them on the PC).
  final Set<CancelToken> _running = {};

  String get _she => _gender == 'male' ? 'he' : 'she';
  String get _her => _gender == 'male' ? 'his' : 'her';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _services = ServicesScope.of(context);
    if (_started) return;
    _started = true;
    _id = widget.characterId;
    unawaited(_load());
  }

  @override
  void dispose() {
    for (final c in _running) {
      c.cancel();
    }
    unawaited(_services.speaker.stop());
    for (final c in _text.values) {
      c.dispose();
    }
    _tags.dispose();
    super.dispose();
  }

  // ---- Load / save -------------------------------------------------------------

  Future<void> _load() async {
    final api = _services.api;
    try {
      final id = _id;
      if (id != null) {
        final answer = await api.character(id);
        _card = Map<String, dynamic>.from(answer['card'] as Map<String, dynamic>);
        _hasVoice = answer['voice'] != null;
      }
      // Optional features: the editor works without them.
      VoiceStatus? voice;
      try {
        voice = await api.voiceStatus();
      } on Object {
        voice = null;
      }
      final photos = await api.photosAvailable().catchError((Object _) => false);
      if (!mounted) return;
      setState(() {
        _fill();
        _speaks = voice?.speaks ?? false;
        _voiceReason = voice?.reason ?? '';
        _readAloud = voice?.readAloud ?? '';
        _photos = photos;
        _loading = false;
      });
    } on Object catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  /// Card → fields.
  void _fill() {
    for (final entry in _text.entries) {
      entry.value.text = (_card[entry.key] as String?) ?? '';
    }
    _tags.text = ((_card['tags'] as List<dynamic>?) ?? const []).cast<String>().join(', ');
    _style = (_card['style'] as String?) ?? 'roleplay';
    _gender = (_card['gender'] as String?) ?? 'female';
    _artStyle = (_card['artStyle'] as String?) ?? 'realistic';
    _background = (_card['background'] as String?) ?? 'scene';
    _savedJson = jsonEncode(_collect());
  }

  /// Fields → card (unknown keys kept as loaded).
  Map<String, dynamic> _collect() => {
        ..._card,
        for (final entry in _text.entries) entry.key: entry.value.text.trim(),
        'tags': _tags.text.split(',').map((t) => t.trim()).where((t) => t.isNotEmpty).take(20).toList(),
        'style': _style,
        'gender': _gender,
        'artStyle': _artStyle,
        'background': _background,
      };

  bool get _dirty => !_loading && jsonEncode(_collect()) != _savedJson;

  Future<bool> _save() async {
    final card = _collect();
    if ((card['name'] as String).isEmpty) {
      _toast('Give the character a name first.');
      return false;
    }
    setState(() => _saving = true);
    try {
      final summary = await _services.api.saveCharacter(_id, card);
      if (!mounted) return true;
      setState(() {
        _id = summary.id;
        _card = card;
        _savedJson = jsonEncode(card);
      });
      _toast('Saved.');
      return true;
    } on Object catch (e) {
      _toast(e.toString());
      return false;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _delete() async {
    final id = _id;
    if (id == null) return;
    final ok = await _confirm(
      title: 'Delete ${_text['name']!.text}?',
      text: 'This deletes the character and all of $_her chats, photos, memories, face and voice. '
          'It cannot be undone.',
      action: 'Delete',
    );
    if (!ok) return;
    try {
      await _services.api.deleteCharacter(id);
      if (mounted) Navigator.of(context).pop();
    } on Object catch (e) {
      _toast(e.toString());
    }
  }

  /// Leaving with unsaved changes: save, discard or stay.
  Future<void> _onPop() async {
    final choice = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Unsaved changes'),
        content: const Text('Save your changes before leaving?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, 'discard'), child: const Text('Discard')),
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Stay')),
          FilledButton(onPressed: () => Navigator.pop(context, 'save'), child: const Text('Save')),
        ],
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'save' && !await _save()) return;
    if (mounted) Navigator.of(context).pop();
  }

  // ---- Helpers ---------------------------------------------------------------------

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<bool> _confirm({required String title, required String text, required String action}) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(text),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: GirllmColors.danger),
            onPressed: () => Navigator.pop(context, true),
            child: Text(action),
          ),
        ],
      ),
    );
    return ok ?? false;
  }

  /// Runs a long PC request (GPU) that closing the editor cancels.
  Future<T?> _gpu<T>(Future<T> Function(CancelToken cancel) run) async {
    final cancel = CancelToken();
    setState(() => _running.add(cancel));
    try {
      return await run(cancel);
    } on Object catch (e) {
      if (!cancel.isCancelled) _toast(e.toString());
      return null;
    } finally {
      if (mounted) setState(() => _running.remove(cancel));
    }
  }

  // ---- Voice ----------------------------------------------------------------------

  final List<String> _voiceCandidates = [];

  Future<void> _designVoice() async {
    final id = _id;
    if (id == null) return;
    final description = _text['voiceDescription']!.text.trim();
    final candidate = await _gpu(
      (cancel) => _services.api.designVoice(id, description.isEmpty ? _voiceHints[_gender]! : description, cancel: cancel),
    );
    if (candidate == null || !mounted) return;
    setState(() => _voiceCandidates.insert(0, candidate));
    unawaited(_playVoice('cand:$candidate', () => _services.api.voiceCandidate(id, candidate)));
  }

  Future<void> _keepVoice(String candidate) async {
    final id = _id;
    if (id == null) return;
    try {
      await _services.api.keepVoice(id, candidate);
      if (!mounted) return;
      setState(() {
        _hasVoice = true;
        _bust++;
        _voiceCandidates.clear();
      });
      _toast('Voice kept: $_she will speak with it.');
    } on Object catch (e) {
      _toast(e.toString());
    }
  }

  Future<void> _recordVoice() async {
    final id = _id;
    if (id == null || !await confirmVoiceConsent(context) || !mounted) return;
    final pcm = await recordVoice(context, textToRead: _readAloud);
    if (pcm == null || !mounted) return;
    final result = await _gpu(
      (_) => _services.api.recordedVoice(id, pcm16ToFloat32Le(pcm), voiceSampleRate),
    );
    if (result == null) return;
    // Kept at once (a recorded voice left as an unkept candidate was the
    // cause of "she doesn't sound like me" on the PC).
    await _keepVoice(result.candidate);
    if (result.transcript.isNotEmpty) _toast('The PC heard: "${result.transcript}"');
  }

  Future<void> _removeVoice() async {
    final id = _id;
    if (id == null) return;
    final ok = await _confirm(
      title: 'Remove $_her voice?',
      text: 'A new voice will be made from the description the next time $_she speaks.',
      action: 'Remove',
    );
    if (!ok) return;
    try {
      await _services.api.removeVoice(id);
      if (mounted) setState(() => _hasVoice = false);
    } on Object catch (e) {
      _toast(e.toString());
    }
  }

  Future<void> _playVoice(String key, Future<Uint8List?> Function() fetch) async {
    try {
      await _services.speaker.speak(key, fetch);
    } on Object catch (e) {
      _toast(e.toString());
    }
  }

  // ---- Pictures -----------------------------------------------------------------

  final Map<String, List<String>> _pictureCandidates = {'face': [], 'background': []};

  Future<void> _generate(String kind) async {
    final id = _id;
    if (id == null) return;
    if (_dirty && !await _save()) return; // pictures are made from the saved card
    final candidates = await _gpu((cancel) => _services.api.generatePictures(id, kind, cancel: cancel));
    if (candidates == null || !mounted) return;
    setState(() => _pictureCandidates[kind] = candidates);
  }

  Future<void> _pick(String kind, String candidate) async {
    final id = _id;
    if (id == null) return;
    try {
      await _services.api.pickPicture(id, kind, candidate);
      if (!mounted) return;
      setState(() {
        _bust++;
        _pictureCandidates[kind] = [];
      });
    } on Object catch (e) {
      _toast(e.toString());
    }
  }

  Future<void> _removePicture(String kind) async {
    final id = _id;
    if (id == null) return;
    try {
      await _services.api.removePicture(id, kind);
      if (mounted) setState(() => _bust++);
    } on Object catch (e) {
      _toast(e.toString());
    }
  }

  Future<void> _uploadFace() async {
    final id = _id;
    if (id == null) return;
    final ok = await _confirm(
      title: 'Whose face is it?',
      text: 'Only upload a picture that is AI-generated, of yourself, or of an adult who agreed to it.',
      action: 'I confirm',
    );
    if (!ok) return;
    // Android's photo picker: no storage permission, only the chosen file.
    final file = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      maxWidth: 2048,
      maxHeight: 2048,
      imageQuality: 92,
    );
    if (file == null) return;
    try {
      await _services.api.uploadFace(id, await file.readAsBytes());
      if (mounted) setState(() => _bust++);
    } on Object catch (e) {
      _toast(e.toString());
    }
  }

  // ---- UI -----------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final busy = _running.isNotEmpty || _saving;
    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_onPop());
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(_id == null ? 'New character' : 'Edit character'),
          actions: [
            if (_id != null)
              IconButton(tooltip: 'Delete', icon: const Icon(Icons.delete_outline), onPressed: busy ? null : _delete),
            IconButton(tooltip: 'Save', icon: const Icon(Icons.check), onPressed: busy ? null : _save),
          ],
        ),
        body: _body(),
      ),
    );
  }

  Widget _body() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!)));
    final theme = Theme.of(context);
    Widget heading(String text) =>
        Padding(padding: const EdgeInsets.fromLTRB(0, 24, 0, 8), child: Text(text, style: theme.textTheme.titleMedium));
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 48),
      children: [
        if (_running.isNotEmpty) const LinearProgressIndicator(),
        ..._fields(_mainFields),
        _choice('Style', _style, const {'roleplay': 'Roleplay', 'texting': 'Text messages'}, (v) => _style = v),
        _choice('Gender', _gender, const {'female': 'Woman', 'male': 'Man'}, (v) => _gender = v),
        TextField(controller: _tags, decoration: const InputDecoration(labelText: 'Tags (comma-separated)')),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: const Text('More (advanced)'),
          children: _fields(_advancedFields),
        ),
        heading('Voice'),
        ..._voiceSection(),
        heading('Appearance in pictures'),
        ..._fields(_pictureFields.take(1)),
        _choice('Art style', _artStyle, const {'realistic': 'Realistic', 'anime': 'Anime'}, (v) => _artStyle = v),
        ..._pictureSection('face', 'Face'),
        heading('Background'),
        _choice(
          'Background',
          _background,
          const {'scene': 'A fixed scene', 'latest': 'The latest photo'},
          (v) => _background = v,
        ),
        ..._fields(_pictureFields.skip(1)),
        ..._pictureSection('background', 'Background'),
      ],
    );
  }

  List<Widget> _fields(Iterable<_Field> fields) => [
        for (final f in fields)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: TextField(
              controller: _text[f.key],
              minLines: f.lines,
              maxLines: f.lines == 1 ? 1 : f.lines + 6,
              maxLength: f.max,
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(
                labelText: f.label,
                alignLabelWithHint: f.lines > 1,
                hintText: f.key == 'voiceDescription' ? _voiceHints[_gender] : null,
                hintMaxLines: 3,
              ),
              onChanged: (_) => setState(() {}), // refreshes PopScope.canPop
            ),
          ),
      ];

  Widget _choice(String label, String value, Map<String, String> options, void Function(String) set) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: DropdownButtonFormField<String>(
          initialValue: options.containsKey(value) ? value : options.keys.first,
          decoration: InputDecoration(labelText: label),
          items: [for (final e in options.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
          onChanged: (v) {
            if (v != null) setState(() => set(v));
          },
        ),
      );

  /// Explains why a section needs a saved character.
  Widget _saveFirst(String what) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text('Save the character first to add $what.', style: const TextStyle(color: GirllmColors.haze)),
      );

  List<Widget> _voiceSection() {
    final id = _id;
    final busy = _running.isNotEmpty;
    return [
      ..._fields(_voiceFields),
      if (id == null)
        _saveFirst('$_her voice')
      else if (!_speaks)
        Text(
          _voiceReason.isEmpty ? 'Voice is not available on the PC.' : _voiceReason,
          style: const TextStyle(color: GirllmColors.haze),
        )
      else ...[
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton.tonalIcon(
              onPressed: busy ? null : _designVoice,
              icon: const Icon(Icons.auto_awesome),
              label: const Text('Create from description'),
            ),
            OutlinedButton.icon(
              onPressed: busy ? null : _recordVoice,
              icon: const Icon(Icons.mic_none),
              label: const Text('Record a real voice'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (_hasVoice)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: _PlayButton(
              playKey: 'voice:$id:$_bust',
              onPlay: () => _playVoice('voice:$id:$_bust', () => _services.api.voice(id)),
            ),
            title: const Text('Current voice'),
            trailing: IconButton(tooltip: 'Remove', icon: const Icon(Icons.delete_outline), onPressed: _removeVoice),
          )
        else
          Text(
            'No voice yet: one will be made from the description the first time $_she speaks.',
            style: const TextStyle(color: GirllmColors.haze),
          ),
        for (final candidate in _voiceCandidates)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: _PlayButton(
              playKey: 'cand:$candidate',
              onPlay: () => _playVoice('cand:$candidate', () => _services.api.voiceCandidate(id, candidate)),
            ),
            title: const Text('New voice'),
            trailing: FilledButton(onPressed: () => _keepVoice(candidate), child: const Text('Keep')),
          ),
      ],
    ];
  }

  List<Widget> _pictureSection(String kind, String title) {
    final id = _id;
    if (id == null) return [_saveFirst('pictures')];
    final busy = _running.isNotEmpty;
    final candidates = _pictureCandidates[kind]!;
    final pictures = _services.pictures;
    return [
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: SizedBox(
              width: 120,
              height: 120,
              child: RemoteImage(
                cacheKey: 'edit:$kind:$id:$_bust',
                cache: pictures,
                load: () => _services.api.picture(id, kind),
                semanticLabel: title,
                placeholder: Container(
                  color: GirllmColors.dusk2,
                  child: const Center(child: Icon(Icons.image_not_supported_outlined)),
                ),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (_photos)
                  FilledButton.tonalIcon(
                    onPressed: busy ? null : () => _generate(kind),
                    icon: const Icon(Icons.auto_awesome),
                    label: const Text('Generate'),
                  ),
                if (kind == 'face')
                  OutlinedButton.icon(
                    onPressed: busy ? null : _uploadFace,
                    icon: const Icon(Icons.upload),
                    label: const Text('Upload'),
                  ),
                TextButton(onPressed: busy ? null : () => _removePicture(kind), child: const Text('Remove')),
              ],
            ),
          ),
        ],
      ),
      if (candidates.isNotEmpty) ...[
        const SizedBox(height: 8),
        const Text('Tap the one you like:'),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final c in candidates)
              InkWell(
                onTap: () => _pick(kind, c),
                borderRadius: BorderRadius.circular(12),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: SizedBox(
                    width: 100,
                    height: 100,
                    child: RemoteImage(
                      cacheKey: 'cand:$kind:$c',
                      cache: pictures,
                      load: () => _services.api.pictureCandidate(id, kind, c),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ],
    ];
  }
}

/// ▶ / ■ for a voice clip, following the shared speaker.
class _PlayButton extends StatelessWidget {
  const _PlayButton({required this.playKey, required this.onPlay});

  final String playKey;
  final VoidCallback onPlay;

  @override
  Widget build(BuildContext context) {
    final speaker = ServicesScope.of(context).speaker;
    return ValueListenableBuilder<String?>(
      valueListenable: speaker.loading,
      builder: (context, loading, _) => ValueListenableBuilder<String?>(
        valueListenable: speaker.playing,
        builder: (context, playing, _) {
          final active = loading == playKey || playing == playKey;
          return IconButton(
            tooltip: active ? 'Stop' : 'Listen',
            onPressed: active ? () => unawaited(speaker.stop()) : onPlay,
            icon: loading == playKey
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : Icon(active ? Icons.stop_circle_outlined : Icons.play_circle_outline),
          );
        },
      ),
    );
  }
}
