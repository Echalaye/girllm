/// First launch: pair with the PC by scanning the QR code shown in the PC's
/// Settings → Phone app. The scanner (zxing) runs on the phone only.
library;

import 'package:flutter/material.dart';
import 'package:flutter_zxing/flutter_zxing.dart';

import '../api/girllm_api.dart';
import 'pairing.dart';

class PairScreen extends StatefulWidget {
  const PairScreen({super.key, required this.onPaired});

  final Future<void> Function(Connection connection) onPaired;

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final TextEditingController _name = TextEditingController(text: 'My phone');
  bool _scanning = false;
  bool _busy = false;
  String? _message;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _onScan(Code code) async {
    if (_busy || !code.isValid) return;
    final text = code.text;
    if (text == null) return;
    setState(() => _busy = true);
    try {
      final info = PairingInfo.parse(text);
      setState(() {
        _scanning = false;
        _message = 'Pairing with ${info.addresses.first}…';
      });
      final connection = await GirllmApi.pair(info, deviceName: _name.text.trim());
      await widget.onPaired(connection);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _scanning = false;
        _message = e is FormatException ? e.message : e.toString();
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Pair with my PC')),
      body: _scanning
          ? Stack(
              children: [
                ReaderWidget(onScan: _onScan, codeFormat: Format.qrCode),
                Positioned(
                  left: 16,
                  right: 16,
                  bottom: 24,
                  child: FilledButton.tonal(
                    onPressed: () => setState(() => _scanning = false),
                    child: const Text('Cancel'),
                  ),
                ),
              ],
            )
          : ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Text('Chat with your characters from this phone.', style: theme.textTheme.titleLarge),
                const SizedBox(height: 12),
                const Text(
                  '1. On your PC, open girllm → Settings → Phone app → "Pair a phone".\n'
                  '2. Make sure this phone is on the same Wi-Fi as the PC.\n'
                  '3. Scan the QR code shown on the PC.',
                ),
                const SizedBox(height: 12),
                Text(
                  'The phone only ever talks to your PC, over an encrypted connection checked against the PC\'s '
                  'own certificate. Nothing goes to the internet.',
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(height: 20),
                TextField(
                  controller: _name,
                  maxLength: 60,
                  decoration: const InputDecoration(labelText: 'Name of this phone (shown on the PC)'),
                ),
                const SizedBox(height: 8),
                FilledButton.icon(
                  onPressed: _busy ? null : () => setState(() => _scanning = true),
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text('Scan the QR code'),
                ),
                if (_busy) const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())),
                if (_message != null)
                  Padding(padding: const EdgeInsets.only(top: 16), child: Text(_message!)),
              ],
            ),
    );
  }
}
