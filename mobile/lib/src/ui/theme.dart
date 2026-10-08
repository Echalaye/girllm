/// The PC page's colours ("night" theme): her lamp-orange, dusky surfaces.
library;

import 'package:flutter/material.dart';

abstract final class GirllmColors {
  static const night = Color(0xFF191A2E);
  static const dusk = Color(0xFF24253F);
  static const dusk2 = Color(0xFF2F3052);
  static const haze = Color(0xFFA19EC6);
  static const moon = Color(0xFFEEEBF7);
  static const lamp = Color(0xFFF0B86E);
  static const lampInk = Color(0xFF2B1A05);
  static const you = Color(0xFF34406E);
  static const danger = Color(0xFFFF8A80);
}

ThemeData girllmTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(
    seedColor: GirllmColors.lamp,
    brightness: brightness,
  ).copyWith(
    primary: GirllmColors.lamp,
    onPrimary: GirllmColors.lampInk,
    surface: brightness == Brightness.dark ? GirllmColors.night : null,
    error: GirllmColors.danger,
  );
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    scaffoldBackgroundColor: brightness == Brightness.dark ? GirllmColors.night : null,
    inputDecorationTheme: const InputDecorationTheme(border: OutlineInputBorder()),
  );
}
