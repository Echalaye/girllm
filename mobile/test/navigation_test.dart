// Regression test: screens pushed on the navigator (chat, editor, dialogs)
// must reach the services. They didn't when the scope wrapped `home` only,
// and the chat opened on a blank page.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:girllm_mobile/main.dart';
import 'package:girllm_mobile/src/api/girllm_api.dart';
import 'package:girllm_mobile/src/pairing/pairing.dart';
import 'package:girllm_mobile/src/services.dart';

void main() {
  testWidgets('a pushed screen reaches the services', (tester) async {
    // Nothing is sent: the client only connects on the first request.
    final api = GirllmApi(
      Connection(addresses: const ['192.168.1.20'], port: 3211, fingerprint: 'ab' * 32, token: 'x' * 43),
    );
    final services = Services(api: api, store: ConnectionStore(), onUnpaired: () async {});
    addTearDown(api.close);

    await tester.pumpWidget(
      GirllmShell(
        services: services,
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (context) => Text('port ${ServicesScope.of(context).api.client.port}'),
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('port 3211'), findsOneWidget);
  });

  testWidgets('not paired: the shell works without services', (tester) async {
    await tester.pumpWidget(const GirllmShell(services: null, home: Text('pair me')));
    expect(find.text('pair me'), findsOneWidget);
  });
}
