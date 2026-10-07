/// The JSON shapes of girllm's API that the app uses.
library;

String _string(Object? v, [String fallback = '']) => v is String ? v : fallback;
bool _bool(Object? v) => v == true;

/// A character in the list.
class CharacterSummary {
  const CharacterSummary({
    required this.id,
    required this.name,
    required this.style,
    required this.artStyle,
    required this.gender,
    required this.hasFace,
  });

  factory CharacterSummary.fromJson(Map<String, dynamic> j) => CharacterSummary(
        id: _string(j['id']),
        name: _string(j['name'], 'Character'),
        style: _string(j['style'], 'roleplay'),
        artStyle: _string(j['artStyle'], 'realistic'),
        gender: _string(j['gender'], 'female'),
        hasFace: _bool(j['hasFace']),
      );

  final String id;
  final String name;
  final String style;
  final String artStyle;
  final String gender;
  final bool hasFace;

  bool get isMale => gender == 'male';
}

/// A chat in the list of a character's chats.
class SessionItem {
  const SessionItem({required this.id, required this.title, required this.updatedAt, required this.messageCount});

  factory SessionItem.fromJson(Map<String, dynamic> j) => SessionItem(
        id: _string(j['id']),
        title: j['title'] as String?,
        updatedAt: DateTime.tryParse(_string(j['updatedAt'])) ?? DateTime.now(),
        messageCount: (j['messageCount'] as num?)?.toInt() ?? 0,
      );

  final String id;
  final String? title;
  final DateTime updatedAt;
  final int messageCount;
}

/// One message. `content` grows while her reply streams in.
class ChatMessage {
  ChatMessage({required this.id, required this.role, required this.content, this.imageId});

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: _string(j['id']),
        role: _string(j['role'], 'assistant'),
        content: _string(j['content']),
        imageId: j['imageId'] as String?,
      );

  String id;
  final String role;
  String content;
  String? imageId;

  bool get isHers => role == 'assistant';
}

/// An open chat.
class SessionView {
  const SessionView({required this.id, required this.characterId, required this.messages, required this.mood});

  factory SessionView.fromJson(Map<String, dynamic> j) {
    final s = j['session'] as Map<String, dynamic>;
    return SessionView(
      id: _string(s['id']),
      characterId: _string(s['characterId']),
      mood: _string(s['mood']),
      messages: (s['messages'] as List<dynamic>).cast<Map<String, dynamic>>().map(ChatMessage.fromJson).toList(),
    );
  }

  final String id;
  final String characterId;
  final String mood;
  final List<ChatMessage> messages;
}

/// Her voice / your voice on the PC.
class VoiceStatus {
  const VoiceStatus({required this.speaks, required this.reason, required this.readAloud});

  factory VoiceStatus.fromJson(Map<String, dynamic> j) {
    final tts = (j['tts'] as Map<String, dynamic>?) ?? const {};
    return VoiceStatus(
      speaks: _bool(tts['available']),
      reason: _string(tts['reason']),
      readAloud: _string(j['readAloud']),
    );
  }

  final bool speaks;
  final String reason;

  /// The text to read when recording a voice (chat language).
  final String readAloud;
}
