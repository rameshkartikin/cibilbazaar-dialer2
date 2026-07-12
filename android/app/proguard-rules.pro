# CibilBazaar Dialer — release Proguard rules.
# Keep protocol data classes intact since they're (de)serialized via
# reflection-free manual JSON parsing, but keep names stable for logs.
-keep class com.cibilbazaar.dialer.protocol.** { *; }
-keepattributes SourceFile,LineNumberTable
-dontwarn kotlinx.coroutines.**
