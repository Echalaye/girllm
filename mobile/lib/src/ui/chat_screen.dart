/// A chat with one character: her replies stream in as she writes, her
/// photos (retake ↻), 🔊 to hear a message, "Voice on" to hear every reply,
/// 📷 to ask for a photo, and the list of chats with her.
library;

import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import '../api/pinned_client.dart';
import '../api/sse.dart';
import '../media/remote_image.dart';
import '../models.dart';
import '../services.dart';
import 'theme.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.character});

  final CharacterSummary character;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final TextEditingController _input = TextEditingController();
  final ScrollController _scroll = ScrollController();
  late Services _services;

  SessionView? _session;
  List<ChatMessage> _messages = [];
  String? _error;

  /// The running request (her reply or a photo), if any: Stop cancels it.
  CancelToken? _running;
  String _presence = '';
  bool _voiceOn = false;
  bool _speaks = false;
  bool _photos = false;

  /// Her picture behind the chat, as set on the PC: 'off', 'subtle', 'clear'.
  String _look = 'off';

  /// Background pictures are fetched again each time the chat is opened
  /// (she may have a new scene since).
  final int _openedAt = DateTime.now().millisecondsSinceEpoch;

  CharacterSummary get _character => widget.character;
  String get _she => _character.isMale ? 'He' : 'She';

  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Read here (not lazily) so dispose() never looks up an inherited widget.
    _services = ServicesScope.of(context);
    if (_started) return;
    _started = true;
    _start();
  }

  @override
  void dispose() {
    _running?.cancel();
    unawaited(_services.speaker.stop());
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    try {
      final api = _services.api;
      final sessions = await api.sessions(_character.id);
      final session = sessions.isEmpty ? await api.createSession(_character.id) : await api.session(sessions.first.id);
      final voice = await api.voiceStatus().catchError((Object _) => const VoiceStatus(speaks: false, reason: '', readAloud: ''));
      final photos = await api.photosAvailable().catchError((Object _) => false);
      final look = await api.chatBackground().catchError((Object _) => 'subtle');
      if (!mounted) return;
      setState(() {
        _open(session);
        _speaks = voice.speaks;
        _photos = photos;
        _look = look;
      });
    } on Object catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  void _open(SessionView session) {
    _session = session;
    _messages = session.messages;
    _error = null;
    _scrollToEnd();
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  // ---- Her reply ----------------------------------------------------------------

  Future<void> _send() async {
    final text = _input.text.trim();
    final session = _session;
    if (text.isEmpty || session == null || _running != null) return;
    _input.clear();
    setState(() => _messages.add(ChatMessage(id: '', role: 'user', content: text)));
    await _stream((cancel) => _services.api.send(session.id, text, cancel));
  }

  Future<void> _regenerate() async {
    final session = _session;
    if (session == null || _running != null) return;
    if (_messages.isNotEmpty && _messages.last.isHers) setState(() => _messages.removeLast());
    await _stream((cancel) => _services.api.regenerate(session.id, cancel));
  }

  /// Show her reply as it is written, then (Voice on) say it.
  Future<void> _stream(Stream<SseEvent> Function(CancelToken cancel) open) async {
    final cancel = CancelToken();
    final reply = ChatMessage(id: '', role: 'assistant', content: '');
    setState(() {
      _running = cancel;
      _presence = 'typing…';
      _messages.add(reply);
    });
    _scrollToEnd();
    try {
      await for (final event in open(cancel)) {
        final data = event.data;
        switch (event.event) {
          case 'token':
            setState(() => reply.content += (data['text'] as String? ?? ''));
            _scrollToEnd();
          case 'done':
            setState(() {
              reply.id = (data['messageId'] as String?) ?? '';
              _presence = '';
            });
            if (_voiceOn && reply.content.isNotEmpty) unawaited(_say(reply));
          case 'photo_start':
            setState(() => _presence = 'sending you a photo…');
          case 'photo':
            setState(() => reply.imageId = data['imageId'] as String?);
            _scrollToEnd();
          case 'photo_error':
            _toast("$_she couldn't send the photo: ${data['message']}");
          case 'error':
            throw ApiException(500, data['message'] as String? ?? 'Error');
        }
      }
    } on Object catch (e) {
      if (!cancel.isCancelled) _toast(e.toString());
    } finally {
      if (mounted) {
        setState(() {
          if (reply.content.isEmpty && reply.imageId == null) _messages.remove(reply);
          _running = null;
          _presence = '';
        });
      }
    }
  }

  // ---- Photos ---------------------------------------------------------------------

  Future<void> _askPhoto() async {
    final session = _session;
    if (session == null || _running != null) return;
    final controller = TextEditingController();
    final request = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Ask for a photo'),
        content: TextField(
          controller: controller,
          maxLength: 300,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'What should it show? (optional)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text.trim()), child: const Text('Ask')),
        ],
      ),
    );
    controller.dispose();
    if (request == null) return;
    final cancel = CancelToken();
    final started = DateTime.now();
    final timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _presence = 'taking a photo… ${DateTime.now().difference(started).inSeconds} s');
    });
    setState(() {
      _running = cancel;
      _presence = 'taking a photo…';
      if (request.isNotEmpty) _messages.add(ChatMessage(id: '', role: 'user', content: '📷 $request'));
    });
    _scrollToEnd();
    try {
      final message = await _services.api.photo(session.id, request, cancel);
      if (!mounted) return;
      setState(() => _messages.add(message));
      _scrollToEnd();
      if (_voiceOn) unawaited(_say(message));
    } on Object catch (e) {
      if (!cancel.isCancelled) _toast(e.toString());
    } finally {
      timer.cancel();
      if (mounted) {
        setState(() {
          _running = null;
          _presence = '';
        });
      }
    }
  }

  Future<void> _retake(ChatMessage message) async {
    final session = _session;
    final old = message.imageId;
    if (session == null || old == null || _running != null) return;
    setState(() => _presence = 'retaking the photo…');
    try {
      final updated = await _services.api.retake(session.id, old);
      _services.pictures.evict('img:$old');
      if (mounted) setState(() => message.imageId = updated.imageId);
    } on Object catch (e) {
      _toast(e.toString());
    } finally {
      if (mounted) setState(() => _presence = '');
    }
  }

  // ---- Her voice --------------------------------------------------------------

  Future<void> _say(ChatMessage message) async {
    final key = message.id.isEmpty ? message.hashCode.toString() : message.id;
    try {
      await _services.speaker.speak(key, () => _services.api.speak(_character.id, message.content));
    } on Object catch (e) {
      _toast('$_she can\'t speak right now: $e');
    }
  }

  // ---- Chats --------------------------------------------------------------------

  Future<void> _newChat() async {
    if (_running != null) return;
    try {
      final session = await _services.api.createSession(_character.id);
      if (mounted) setState(() => _open(session));
    } on Object catch (e) {
      _toast(e.toString());
    }
  }

  Future<void> _chooseChat() async {
    final sessions = await _services.api.sessions(_character.id).catchError((Object e) {
      _toast(e.toString());
      return <SessionItem>[];
    });
    if (!mounted || sessions.isEmpty) return;
    final chosen = await showModalBottomSheet<SessionItem>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final s in sessions)
              ListTile(
                title: Text(s.title ?? 'New chat'),
                subtitle: Text('${s.messageCount} messages · ${MaterialLocalizations.of(context).formatShortDate(s.updatedAt)}'),
                selected: s.id == _session?.id,
                onTap: () => Navigator.pop(context, s),
              ),
          ],
        ),
      ),
    );
    if (chosen == null || chosen.id == _session?.id) return;
    try {
      final session = await _services.api.session(chosen.id);
      if (mounted) setState(() => _open(session));
    } on Object catch (e) {
      _toast(e.toString());
    }
  }

  // ---- Her picture behind the chat (same rules as the PC page) ---------------

  /// "latest": her latest photo in this chat, else her scene, else her face;
  /// "scene": her scene, else her face. null: nothing behind the chat.
  _BackdropSource? _backdrop() {
    if (_look == 'off' || _session == null) return null;
    final c = _character;
    final api = _services.api;
    if (c.background == 'latest') {
      for (final m in _messages.reversed) {
        final imageId = m.imageId;
        if (imageId != null) return (key: 'img:$imageId', load: () => api.image(imageId));
      }
    }
    if (c.hasBackground) {
      return (key: 'bg:${c.id}:$_openedAt', load: () => api.picture(c.id, 'background'));
    }
    if (c.hasFace) return (key: 'face:${c.id}:$_openedAt', load: () => api.picture(c.id, 'face'));
    return null;
  }

  // ---- UI -----------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final busy = _running != null;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_character.name),
            if (_presence.isNotEmpty || (_session?.mood.isNotEmpty ?? false))
              Text(
                _presence.isNotEmpty ? _presence : 'Mood: ${_session!.mood}',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(color: GirllmColors.haze),
              ),
          ],
        ),
        actions: [
          if (_speaks)
            IconButton(
              tooltip: _voiceOn ? 'Stop reading replies aloud' : 'Read replies aloud',
              icon: Icon(_voiceOn ? Icons.volume_up : Icons.volume_off_outlined),
              onPressed: () {
                setState(() => _voiceOn = !_voiceOn);
                if (!_voiceOn) unawaited(_services.speaker.stop());
              },
            ),
          if (_photos)
            IconButton(tooltip: 'Ask for a photo', icon: const Icon(Icons.photo_camera_outlined), onPressed: busy ? null : _askPhoto),
          PopupMenuButton<String>(
            onSelected: (value) => switch (value) {
              'regenerate' => _regenerate(),
              'new' => _newChat(),
              'chats' => _chooseChat(),
              _ => Future<void>.value(),
            },
            itemBuilder: (_) => [
              PopupMenuItem(value: 'regenerate', enabled: !busy, child: const Text('Regenerate her last reply')),
              PopupMenuItem(value: 'new', enabled: !busy, child: const Text('New chat')),
              const PopupMenuItem(value: 'chats', child: Text('Chats')),
            ],
          ),
        ],
      ),
      body: Stack(
        children: [
          if (_backdrop() case final source?) Positioned.fill(child: _Backdrop(source: source, look: _look)),
          Column(
            children: [
              Expanded(child: _body()),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _input,
                          minLines: 1,
                          maxLines: 5,
                          maxLength: 8000,
                          textCapitalization: TextCapitalization.sentences,
                          decoration: InputDecoration(
                            hintText: 'Message ${_character.name}…',
                            counterText: '',
                            isDense: true,
                          ),
                          onSubmitted: (_) => _send(),
                        ),
                      ),
                      const SizedBox(width: 8),
                      busy
                          ? IconButton.filledTonal(
                              tooltip: 'Stop',
                              icon: const Icon(Icons.stop),
                              onPressed: () => _running?.cancel(),
                            )
                          : IconButton.filled(tooltip: 'Send', icon: const Icon(Icons.send), onPressed: _send),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _body() {
    if (_error != null) return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!)));
    if (_session == null) return const Center(child: CircularProgressIndicator());
    if (_messages.isEmpty) return Center(child: Text('Say hello to ${_character.name}.'));
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
      itemCount: _messages.length,
      itemBuilder: (context, i) => _Bubble(
        message: _messages[i],
        characterId: _character.id,
        canSpeak: _speaks,
        onSpeak: _say,
        onRetake: _running == null ? _retake : null,
      ),
    );
  }
}

/// One message: her text (with *actions* in italics), her photo, 🔊.
class _Bubble extends StatelessWidget {
  const _Bubble({
    required this.message,
    required this.characterId,
    required this.canSpeak,
    required this.onSpeak,
    required this.onRetake,
  });

  final ChatMessage message;
  final String characterId;
  final bool canSpeak;
  final Future<void> Function(ChatMessage) onSpeak;
  final Future<void> Function(ChatMessage)? onRetake;

  @override
  Widget build(BuildContext context) {
    final hers = message.isHers;
    final imageId = message.imageId;
    final key = message.id.isEmpty ? message.hashCode.toString() : message.id;
    return Align(
      alignment: hers ? Alignment.centerLeft : Alignment.centerRight,
      child: Container(
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.82),
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
        decoration: BoxDecoration(
          color: hers ? GirllmColors.dusk : GirllmColors.you,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(18),
            topRight: const Radius.circular(18),
            bottomLeft: Radius.circular(hers ? 6 : 18),
            bottomRight: Radius.circular(hers ? 18 : 6),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (imageId != null) _Photo(imageId: imageId, onRetake: onRetake == null ? null : () => onRetake!(message)),
            if (message.content.isNotEmpty)
              Text.rich(_withActions(message.content), style: const TextStyle(color: GirllmColors.moon, height: 1.35))
            else if (hers && imageId == null)
              const Padding(padding: EdgeInsets.all(4), child: SizedBox(width: 24, height: 12, child: LinearProgressIndicator())),
            if (hers && canSpeak && message.content.isNotEmpty && message.id.isNotEmpty)
              Align(
                alignment: Alignment.centerRight,
                child: _SpeakButton(messageKey: key, onPressed: () => onSpeak(message)),
              ),
          ],
        ),
      ),
    );
  }

  /// "*smiles* Hi" → "smiles" in italics, the rest normal.
  static TextSpan _withActions(String text) {
    final parts = text.split('*');
    return TextSpan(
      children: [
        for (var i = 0; i < parts.length; i++)
          if (parts[i].isNotEmpty)
            TextSpan(
              text: parts[i],
              style: i.isOdd ? const TextStyle(fontStyle: FontStyle.italic, color: GirllmColors.haze) : null,
            ),
      ],
    );
  }
}

class _SpeakButton extends StatelessWidget {
  const _SpeakButton({required this.messageKey, required this.onPressed});

  final String messageKey;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final services = ServicesScope.of(context);
    final s = services.speaker;
    return ValueListenableBuilder<String?>(
      valueListenable: s.loading,
      builder: (context, loading, _) => ValueListenableBuilder<String?>(
        valueListenable: s.playing,
        builder: (context, playing, _) {
          final isLoading = loading == messageKey;
          final isPlaying = playing == messageKey;
          return IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: isPlaying || isLoading ? 'Stop' : 'Listen',
            onPressed: isPlaying || isLoading ? () => unawaited(s.stop()) : onPressed,
            icon: isLoading
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : Icon(isPlaying ? Icons.stop_circle_outlined : Icons.volume_up_outlined, size: 20, color: GirllmColors.haze),
          );
        },
      ),
    );
  }
}

class _Photo extends StatelessWidget {
  const _Photo({required this.imageId, required this.onRetake});

  /// Width of a photo in its bubble (the bubble is 82 % of the screen).
  static double bubbleWidth(BuildContext context) => MediaQuery.sizeOf(context).width * 0.82;

  final String imageId;
  final VoidCallback? onRetake;

  @override
  Widget build(BuildContext context) {
    final services = ServicesScope.of(context);
    // In the bubble: decoded at bubble size; full screen: at full size.
    Widget image({double? decodeWidth}) => RemoteImage(
          cacheKey: 'img:$imageId',
          cache: services.pictures,
          load: () => services.api.image(imageId),
          fit: BoxFit.contain,
          decodeWidth: decodeWidth,
          semanticLabel: 'Photo',
          placeholder: const SizedBox(height: 240, child: Center(child: CircularProgressIndicator(strokeWidth: 2))),
        );
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Stack(
        children: [
          GestureDetector(
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => Scaffold(
                  backgroundColor: Colors.black,
                  appBar: AppBar(backgroundColor: Colors.black),
                  body: Center(child: InteractiveViewer(maxScale: 5, child: image())),
                ),
              ),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: image(decodeWidth: bubbleWidth(context)),
            ),
          ),
          if (onRetake != null)
            Positioned(
              top: 6,
              right: 6,
              child: IconButton.filledTonal(
                tooltip: 'Retake this photo (same scene, new picture)',
                icon: const Icon(Icons.refresh),
                onPressed: onRetake,
              ),
            ),
        ],
      ),
    );
  }
}

/// A picture behind the chat: the key caches it, the loader fetches it.
typedef _BackdropSource = ({String key, Future<Uint8List?> Function() load});

/// Her picture behind the chat, dimmed so the text keeps its contrast
/// (like the PC page): "subtle" = blurred, "clear" = sharp but darker.
class _Backdrop extends StatelessWidget {
  const _Backdrop({required this.source, required this.look});

  final _BackdropSource source;
  final String look;

  @override
  Widget build(BuildContext context) {
    final services = ServicesScope.of(context);
    final width = MediaQuery.sizeOf(context).width;
    final subtle = look != 'clear';
    Widget picture = RemoteImage(
      cacheKey: source.key,
      cache: services.pictures,
      load: source.load,
      fit: BoxFit.cover,
      // Blurred anyway: a third of the width is plenty, and much lighter.
      decodeWidth: subtle ? width / 3 : width,
      showError: false, // no picture: the plain background
      placeholder: const SizedBox.shrink(),
    );
    if (subtle) {
      picture = ImageFiltered(
        imageFilter: ImageFilter.blur(sigmaX: 14, sigmaY: 14),
        // Slightly larger: hides the blurred edges.
        child: Transform.scale(scale: 1.06, child: picture),
      );
    }
    const night = GirllmColors.night;
    return IgnorePointer(
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 600),
        child: Stack(
          key: ValueKey(source.key),
          fit: StackFit.expand,
          children: [
            picture,
            DecoratedBox(
              decoration: subtle
                  ? BoxDecoration(color: night.withValues(alpha: 0.62))
                  : BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [night.withValues(alpha: 0.55), night.withValues(alpha: 0.75)],
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
