# 12id fork change (F6): rules applied to apps that minify with R8.

# The framework registers message classes by KClass and resolves their kotlinx.serialization
# serializers reflectively (MessageSerializer), so model classes, companions and generated
# serializers must survive. The framework is small; keep it whole rather than guess.
-keep class org.hyperledger.ariesframework.** { *; }
-keepclassmembers class org.hyperledger.ariesframework.** { *** Companion; }

# UniFFI bindings (askar_uniffi, anoncreds_uniffi, indy_vdr_uniffi) call native code through JNA,
# which looks up classes, fields and callbacks by name.
-keep class *_uniffi.** { *; }
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-dontwarn java.awt.**
-dontwarn com.sun.jna.**

# slf4j-api without a binding on the classpath (F5): the host app may add one.
-dontwarn org.slf4j.impl.**
