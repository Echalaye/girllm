/// girllm's API on your PC, as used by the app. Same routes as the PC page,
/// served by the PC's phone listener (HTTPS, paired phones only).
library;

import 'dart:typed_data';

import '../models.dart';
import '../pairing/pairing.dart';
import 'pinned_client.dart';
import 'sse.dart';

/// Header attesting a real person's face/voice may be used (checked by the PC).
const _consentHeader = 'x-girllm-consent';

class GirllmApi {
  GirllmApi(Connection connection)
      : client = PinnedClient(
          addresses: connection.addresses,
          port: connection.port,
          fingerprint: connection.fingerprint,
          token: connection.token,
        );

  final PinnedClient client;

  /// Exchange the QR code's one-time code for this phone's token. Tries each
  /// address of the code; returns the saved connection.
  static Future<Connection> pair(PairingInfo info, {String deviceName = 'Android phone'}) async {
    final client = PinnedClient(addresses: info.addresses, port: info.port, fingerprint: info.fingerprint);
    try {
      String? token;
      await client.connect(() async {
        final answer = await client.json('POST', '/api/pair', body: {'code': info.code, 'name': deviceName});
        token = (answer! as Map<String, dynamic>)['token'] as String;
      });
      return Connection(addresses: info.addresses, port: info.port, fingerprint: info.fingerprint, token: token!)
          .preferring(client.address);
    } finally {
      client.close();
    }
  }

  /// Reach the PC (on whichever address answers). Returns the address used.
  Future<String> connect() async {
    await client.connect(() => client.json('GET', '/api/health'));
    return client.address;
  }

  /// How her picture is shown behind the chat (a PC setting): 'off',
  /// 'subtle' (blurred) or 'clear'.
  Future<String> chatBackground() async {
    final config = await client.json('GET', '/api/config') as Map<String, dynamic>;
    final look = config['chatBackground'];
    return look is String ? look : 'subtle';
  }

  // ---- Characters -------------------------------------------------------------

  Future<List<CharacterSummary>> characters() async {
    final list = await client.json('GET', '/api/characters') as List<dynamic>;
    return list.cast<Map<String, dynamic>>().map(CharacterSummary.fromJson).toList();
  }

  /// The editable card (`card`), plus `voice` (null when she has none yet).
  Future<Map<String, dynamic>> character(String id) async =>
      await client.json('GET', '/api/characters/${Uri.encodeComponent(id)}') as Map<String, dynamic>;

  /// Create (no id) or update a character. Returns its summary.
  Future<CharacterSummary> saveCharacter(String? id, Map<String, dynamic> card) async {
    final answer = id == null
        ? await client.json('POST', '/api/characters', body: card)
        : await client.json('PUT', '/api/characters/${Uri.encodeComponent(id)}', body: card);
    return CharacterSummary.fromJson(answer! as Map<String, dynamic>);
  }

  Future<void> deleteCharacter(String id) => client.json('DELETE', '/api/characters/${Uri.encodeComponent(id)}');

  // ---- Chats ------------------------------------------------------------------

  Future<List<SessionItem>> sessions(String characterId) async {
    final list = await client.json('GET', '/api/characters/${Uri.encodeComponent(characterId)}/sessions') as List<dynamic>;
    return list.cast<Map<String, dynamic>>().map(SessionItem.fromJson).toList();
  }

  Future<SessionView> createSession(String characterId) async => SessionView.fromJson(
        await client.json('POST', '/api/sessions', body: {'characterId': characterId}) as Map<String, dynamic>,
      );

  Future<SessionView> session(String id) async =>
      SessionView.fromJson(await client.json('GET', '/api/sessions/$id') as Map<String, dynamic>);

  Future<void> deleteSession(String id) => client.json('DELETE', '/api/sessions/$id');

  Stream<SseEvent> send(String sessionId, String text, CancelToken cancel) =>
      client.events('/api/sessions/$sessionId/messages', {'text': text}, cancel: cancel);

  Stream<SseEvent> regenerate(String sessionId, CancelToken cancel) =>
      client.events('/api/sessions/$sessionId/regenerate', <String, dynamic>{}, cancel: cancel);

  /// She sends a photo (20–60 s). Returns her message with its image.
  Future<ChatMessage> photo(String sessionId, String request, CancelToken cancel) async {
    final answer = await client.json('POST', '/api/sessions/$sessionId/photo', body: {'request': request}, cancel: cancel);
    return ChatMessage.fromJson((answer! as Map<String, dynamic>)['message'] as Map<String, dynamic>);
  }

  /// Same scene, new picture. Returns the message with its new image.
  Future<ChatMessage> retake(String sessionId, String imageId) async {
    final answer = await client.json('POST', '/api/sessions/$sessionId/images/$imageId/retake');
    return ChatMessage.fromJson((answer! as Map<String, dynamic>)['message'] as Map<String, dynamic>);
  }

  Future<Uint8List?> image(String imageId) => client.bytes('GET', '/api/images/$imageId');

  Future<bool> photosAvailable() async {
    final status = await client.json('GET', '/api/images/status') as Map<String, dynamic>;
    return status['available'] == true;
  }

  // ---- Voice ------------------------------------------------------------------

  Future<VoiceStatus> voiceStatus() async =>
      VoiceStatus.fromJson(await client.json('GET', '/api/voice') as Map<String, dynamic>);

  /// Her voice saying [text] (FLAC), or null when there is nothing to say.
  Future<Uint8List?> speak(String characterId, String text, {CancelToken? cancel}) =>
      client.bytes('POST', '/api/tts', body: {'characterId': characterId, 'text': text}, cancel: cancel);

  // ---- Her pictures and voice (editor) ----------------------------------------

  String _base(String characterId) => '/api/characters/${Uri.encodeComponent(characterId)}';

  /// `kind`: 'face' or 'background'.
  Future<Uint8List?> picture(String characterId, String kind) => client.bytes('GET', '${_base(characterId)}/$kind');

  /// Generate a few pictures to choose from (GPU, ~20–60 s). Cancelling
  /// closes the request, which stops the generation on the PC.
  Future<List<String>> generatePictures(String characterId, String kind, {CancelToken? cancel}) async {
    final answer =
        await client.json('POST', '${_base(characterId)}/$kind/candidates', cancel: cancel) as Map<String, dynamic>;
    return (answer['candidates'] as List<dynamic>).cast<String>();
  }

  Future<Uint8List?> pictureCandidate(String characterId, String kind, String candidate) =>
      client.bytes('GET', '${_base(characterId)}/$kind/candidates/$candidate');

  Future<void> pickPicture(String characterId, String kind, String candidate) =>
      client.json('POST', '${_base(characterId)}/$kind/candidates/$candidate');

  Future<void> removePicture(String characterId, String kind) => client.json('DELETE', '${_base(characterId)}/$kind');

  /// Upload a photo as her face, with the user's attestation.
  Future<void> uploadFace(String characterId, Uint8List bytes) => client.json(
        'PUT',
        '${_base(characterId)}/face',
        bytes: bytes,
        headers: {_consentHeader: 'adult-and-consenting'},
      );

  Future<Uint8List?> voice(String characterId) => client.bytes('GET', '${_base(characterId)}/voice');

  Future<void> removeVoice(String characterId) => client.json('DELETE', '${_base(characterId)}/voice');

  /// Design a voice from a description; returns the candidate id.
  Future<String> designVoice(String characterId, String description, {CancelToken? cancel}) async {
    final answer = await client.json(
      'POST',
      '${_base(characterId)}/voice/candidates',
      body: {'description': description},
      cancel: cancel,
    ) as Map<String, dynamic>;
    return answer['candidate'] as String;
  }

  Future<Uint8List?> voiceCandidate(String characterId, String candidate) =>
      client.bytes('GET', '${_base(characterId)}/voice/candidates/$candidate');

  Future<void> keepVoice(String characterId, String candidate) =>
      client.json('POST', '${_base(characterId)}/voice/candidates/$candidate');

  /// A recorded voice (float32 LE mono at [sampleRate]), with the user's
  /// attestation. Returns the candidate and what the PC heard.
  Future<({String candidate, String transcript})> recordedVoice(String characterId, Uint8List float32, int sampleRate) async {
    final answer = await client.json(
      'PUT',
      '${_base(characterId)}/voice/candidates',
      bytes: float32,
      query: {'rate': '$sampleRate', 'source': 'recorded'},
      headers: {_consentHeader: 'own-voice-or-consenting-adult'},
    ) as Map<String, dynamic>;
    return (candidate: answer['candidate'] as String, transcript: answer['transcript'] as String);
  }

  void close() => client.close();
}
