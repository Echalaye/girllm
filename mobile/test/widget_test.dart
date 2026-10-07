// Widget test of the first screen (replaces the counter test that
// `flutter create` generates; keeping this file stops it from coming back).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:girllm_mobile/src/pairing/pair_screen.dart';

void main() {
  testWidgets('the pairing screen explains what to do and offers the scanner', (tester) async {
    await tester.pumpWidget(MaterialApp(home: PairScreen(onPaired: (_) async {})));

    expect(find.text('Pair with my PC'), findsOneWidget);
    expect(find.textContaining('Nothing goes to the internet'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'My phone'), findsOneWidget);
    // The camera only starts when asked for.
    expect(find.text('Scan the QR code'), findsOneWidget);
  });
}
